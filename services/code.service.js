/* globals gc */
const util = require('util')
const exec = util.promisify(require('child_process').exec)
const os = require('os')
const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3').verbose()
const { PYTHON, PROMPTV1, PROMPTV2 } = require('../enums/supportedLanguages')
const logger = require('../loader').helpers.l
const OpenAI = require('openai')
const openai = new OpenAI()
const { LANGUAGES_CONFIG } = require('../configs/language.config')
const Joi = require('joi')
const memoryUsedThreshold = process.env.MEMORY_USED_THRESHOLD || 512
const getDefaultAIEvalSystemPrompt = require('../helpers/defaultAIEvalSystemPrompt')
const supportedLanguages = require('../enums/supportedLanguages')
const { default: axios } = require('axios')
const { generate } = require('@builder.io/sqlgenerate')
const parser = require('sqlite-parser')

const _runScript = async (cmd, res, runMemoryCheck = false) => {
    let initialMemory = 0
    let memoryCheckInterval
    let childProcess
    let isChildKilled = false
    try {
        if (runMemoryCheck) {
            memoryCheckInterval = setInterval(async () => {
                if (!initialMemory) {
                    initialMemory = Math.round((os.freemem() / 1024 / 1024))
                    logger.info({
                        initial_memory: initialMemory,
                    })
                }

                if ((initialMemory - Math.round((os.freemem() / 1024 / 1024))) > memoryUsedThreshold) {
                    /**
                     * detection logic of memory limit exceeded
                     */
                    logger.info({
                        use_mem: (initialMemory - Math.round((os.freemem() / 1024 / 1024))),
                        free_mem: Math.round((os.freemem() / 1024 / 1024)),
                        total_mem: Math.round((os.totalmem() / 1024 / 1024)),
                    })
                    logger.warn('Memory exceeded')

                    if (childProcess) {
                        childProcess.kill('SIGKILL')
                        isChildKilled = true
                    } else {
                        logger.warn('Child process is undefined and response is on way, trying to send another response')
                        _respondWithMemoryExceeded(res)
                    }
                }
            }, 50)
        }

        const execPromise = exec(cmd)
        childProcess = execPromise.child

        const result = await execPromise

        if (memoryCheckInterval) {
            clearInterval(memoryCheckInterval); childProcess = undefined
        }

        return { result }
    } catch (e) {
        if (memoryCheckInterval) {
            clearInterval(memoryCheckInterval); childProcess = undefined
        }

        if (isChildKilled) {
            /**
             * Logic for doing proper garbage collection once child process is killed
             * 2 sec delay is added just to give enough time for GC to happen
             */
            gc()
            await new Promise(resolve => setTimeout(resolve, 2000))
            // need some way to know from the error message that memory is the issue
            e.message = e.message + ' Process killed due to Memory Limit Exceeded'
        }
        // languages like java, c and c++ sometimes throw an error and write it to stdout
        return { error: e.message, stdout: e.stdout, stderr: e.stderr }
    }
}

const _respondWithMemoryExceeded = (res) => {
    if (!res.headersSent) {
        res.status(200).send({
            output: 'Memory exceeded',
            execute_time: null,
            status_code: 200,
            memory: null,
            cpu_time: null,
            output_files: [],
            compile_message: '',
            error: 1,
        })
    }
}

const _prepareErrorMessage = (outputLog, language, command) => {
    let errorMsg = outputLog?.error ?? ''
    // strip the command info
    if (errorMsg.startsWith('Command failed:')) {
        errorMsg = errorMsg.replace('Command failed: ' + command, '')
    }

    // Remove file path info
    if (language === PYTHON) {
        errorMsg = errorMsg.replace(/File ".*\/(.*?)"/g, 'File "$1"')
    }

    const subString = 'MemoryError\n'
    if ((errorMsg.substring(errorMsg.length - subString.length, errorMsg.length) === subString) || errorMsg.includes('Process killed due to Memory Limit Exceeded')) {
        errorMsg = 'Memory limit exceeded'
    }

    // In case of no error message, the msg could be in stdout
    if (!errorMsg.trim()) errorMsg = outputLog?.stdout || 'Time limit exceeded'

    return errorMsg.trim()
}

const _executePrompt = async (
    count,
    langConfig,
    prompt,
    points = 10, // Maximum points that can be given by open AI
) => {
    const promises = Array.from({ length: count }, () =>
        openai.chat.completions.create({
            messages: [
                {
                    role: 'system',
                    content: getDefaultAIEvalSystemPrompt(points),
                },
                {
                    role: 'user',
                    content: prompt,
                },
            ],
            model: langConfig.model,
            response_format: {
                type: 'json_object',
            },
            temperature: 0.1,
        }),
    )

    const evaluatedResponses = await Promise.allSettled(promises)
    let errorResponsesCount = 0
    const allValidResponses = []

    evaluatedResponses.forEach(res => {
        if (res.status === 'fulfilled') {
            let openAIResponse = {}
            if (res.value.choices[0]?.message) {
                openAIResponse = JSON.parse(res.value.choices[0].message.content)
            }

            const schema = Joi.object({
                score: Joi.number().integer().required(),
                rationale: Joi.object({
                    positives: Joi.string().required().allow(''),
                    negatives: Joi.string().required().allow(''),
                }).required(),
                points: Joi.number().integer().required(),
            })

            const validatedData = schema.validate(openAIResponse)
            if (validatedData.error || openAIResponse.points !== points) {
                logger.error(`The response received from Open AI failed the validation check: ${JSON.stringify(validatedData)}`)
                ++errorResponsesCount
            } else {
                allValidResponses.push(openAIResponse)
            }
        } else {
            logger.error('No response received from Open AI')
            ++errorResponsesCount
        }
    })
    return { allValidResponses, errorResponsesCount }
}

const _executeCode = async (req, res, response) => {
    let args = null
    let code = null
    let hasInputFiles = false
    let language = null
    let stdin = null

    try {
        // Parse Input
        // eslint-disable-next-line no-unused-vars
        args = req.args
        // eslint-disable-next-line no-unused-vars
        hasInputFiles = req.hasInputFiles

        code = req.script
        language = req.language
        stdin = req.stdin
        const langConfig = LANGUAGES_CONFIG[language]
        // Remove all files from tmp folder
        await _runScript('rm -rf /tmp/*', res)

        // Write file in tmp folder based on language
        await fs.promises.writeFile(`/tmp/${langConfig.filename}`, code)

        const compileCommand = `cd /tmp/ && ${langConfig.compile}`
        // Run compile command
        const compileLog = await _runScript(compileCommand, res, true)
        response.compileMessage =
            compileLog.error !== undefined ? _prepareErrorMessage(compileLog, language, compileCommand) : ''

        // Check if there is no compilation error
        if (response.compileMessage === '') {
            let command
            if (language === 'java') {
                // Remove ulimit as a temp fix
                command = `cd /tmp/ && timeout ${langConfig.timeout}s ${langConfig.run}`
            } else {
                command = `cd /tmp/ && ulimit -v ${langConfig.memory} && ulimit -m ${langConfig.memory} && timeout ${langConfig.timeout}s ${langConfig.run}`
            }

            // Check if there is any input that is to be provided to code execution
            if (stdin) {
                // Write input in a file in tmp folder
                await fs.promises.writeFile('/tmp/input.txt', stdin)
                // Update the execution command
                command += ' < input.txt'
            }

            const outputLog = await _runScript(command, res, true)
            response.output =
                outputLog.error !== undefined
                    ? _prepareErrorMessage(outputLog, language, command)
                    : outputLog.result.stdout
            if (outputLog.error) {
                response.error = 1
            }
        } else {
            response.error = 1
        }
    } catch (e) {
        logger.error(e)
        throw new Error('Unable to execute code.')
    }
}

// This function expects an array of size greater than 0
const _calculateScoreConfidence = (evaluations) => {
    const scoreDetails = new Map()

    for (let i = 0; i < evaluations.length; ++i) {
        const score = evaluations[i].score
        if (scoreDetails.has(score)) {
            const details = scoreDetails.get(score)
            details.frequency++
            scoreDetails.set(score, details)
        } else {
            scoreDetails.set(score, {
                frequency: 1,
                rationale: evaluations[i].rationale,
                points: evaluations[i].points,
            })
        }
    }

    const sortedEntries = Array.from(scoreDetails.entries())
        .map(([score, details]) => ({
            score,
            frequency: details.frequency,
            rationale: details.rationale,
            points: details.points,
        }))
        .sort((a, b) => b.frequency - a.frequency)

    const highestFrequencyDetails = sortedEntries[0]

    return {
        score: highestFrequencyDetails.score,
        frequency: highestFrequencyDetails.frequency,
        rationale: highestFrequencyDetails.rationale,
        points: highestFrequencyDetails.points,
        total: evaluations.length,
    }
}

const _getAiScore = async (langConfig, question, response, points, userAnswer, rubric) => {
    try {
        const prompt = `Question: ${question}\n\nRubric: ${rubric}\n\nAnswer: ${userAnswer}`
        let totalRequests = 0
        let totalValidRequests = 0

        let { allValidResponses, errorResponsesCount } = await _executePrompt(3, langConfig, prompt, points)
        totalRequests += 3
        totalValidRequests += (3 - errorResponsesCount)

        if (errorResponsesCount === 3) {
            throw new Error('Open AI is not responding with valid responses or It is not in service')
        }

        let scoreConfidence = _calculateScoreConfidence(allValidResponses)

        // If there's variation in the scores, increase the number of requests
        if (scoreConfidence.frequency !== 3) {
            const { allValidResponses: additionalValidResponses, errorResponsesCount: additionalErrorCount } = await _executePrompt(
                7 + errorResponsesCount,
                langConfig,
                prompt,
                points,
            )

            if ((7 + errorResponsesCount) === additionalErrorCount) {
                throw new Error(
                    'Open AI is not responding with valid responses or It is not in service',
                )
            }

            allValidResponses = allValidResponses.concat(additionalValidResponses)
            totalRequests += (7 + errorResponsesCount)
            totalValidRequests += (7 + errorResponsesCount - additionalErrorCount)
            scoreConfidence = _calculateScoreConfidence(allValidResponses)

            if (scoreConfidence.frequency / scoreConfidence.total < 0.5 && totalValidRequests < 10) {
                const {
                    allValidResponses: additionalValidResponses,
                    errorResponsesCount: additionalErrorNewCount,
                } = await _executePrompt(
                    5 + additionalErrorCount,
                    langConfig,
                    prompt,
                    points,
                )

                if ((5 + additionalErrorCount) === additionalErrorNewCount) {
                    throw new Error(
                        'Open AI is not responding with valid responses or It is not in service',
                    )
                }

                allValidResponses = allValidResponses.concat(additionalValidResponses)
                totalRequests += (5 + additionalErrorCount)
                scoreConfidence = _calculateScoreConfidence(allValidResponses)
            }
        } else {
            response.output = {
                score: scoreConfidence.score,
                points: scoreConfidence.points,
                rationale: scoreConfidence.rationale,
                confidence:
                    (scoreConfidence.frequency / scoreConfidence.total) * 100,
            }
            return
        }

        // Keep requesting until a high confidence score is determined, respecting the request limit
        while (totalRequests < 20) {
            const {
                allValidResponses: additionalValidResponses,
            } = await _executePrompt(1, langConfig, prompt, points)

            allValidResponses = allValidResponses.concat(additionalValidResponses)
            ++totalRequests
            scoreConfidence = _calculateScoreConfidence(allValidResponses)
            if (allValidResponses.length >= 10 && scoreConfidence.frequency / scoreConfidence.total >= 0.5) {
                break
            }
        }

        if (allValidResponses.length < 10) {
            throw new Error('We were not able to achieve 10 valid evaluations from Open AI to generate a confidence')
        }

        const confidence = (scoreConfidence.frequency / scoreConfidence.total) * 100
        response.output = {
            score: scoreConfidence.score,
            points: scoreConfidence.points,
            rationale: scoreConfidence.rationale,
            confidence,
        }
    } catch (err) {
        throw new Error(err.message)
    }
}

const _executeStatement = (db, sql) => {
    return new Promise((resolve, reject) => {
        db.all(sql, function(err, rows) {
            if (err) {
                reject(err);
            } else {
                resolve(rows)
            }
        })
    })
}

const _executeSqlQueries = async (dbPath, queries) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => {
        if (err) {
            throw new Error(
                'Was not able to connect to the SQLite database: ' + err.message,
            )
        }
    })

    const cleanedQueries = []
    try {
        const ast = parser(queries);
        if (!ast) {
            return { data: [] }
        }
        for (const statement of ast.statement) {
            cleanedQueries.push(generate(statement))
        }
    } catch (err) {
        return { error: true, data: err.message }
    }

    for (let i = 0; i < cleanedQueries.length; i++) {
        try {
            const res = await _executeStatement(db, cleanedQueries[i])
            if (i == cleanedQueries.length - 1) {
                return { data: res }
            }
        } catch (err) {
            logger.error(err)
            return {
                error: true, data: `${err.message} at statement ${i + 1}`
            }
        }
    }
}

const _downloadSqliteDatabase = async (fileUrl, dbPath) => {
    const writer = fs.createWriteStream(dbPath)
    const response = await axios({
        url: fileUrl,
        method: 'GET',
        responseType: 'stream',
    })

    response.data.pipe(writer)

    return new Promise((resolve, reject) => {
        writer.on('finish', resolve)
        writer.on('error', reject)
    })
}

const _executeSqlite3Query = async (req, res, response) => {
    const dbPath = '/tmp/database.db'
    try {
        const dbDirectory = path.dirname(dbPath)
        if (!fs.existsSync(dbDirectory)) {
            fs.mkdirSync(dbDirectory, { recursive: true })
        }
        if (!fs.existsSync(dbPath)) {
            fs.closeSync(fs.openSync(dbPath, 'w'))
        }
        await _downloadSqliteDatabase(req.stdin, dbPath)
        const queryResults = await _executeSqlQueries(dbPath, req.script, response)
        if (queryResults.error) {
            response.error = 1
        }
        response.output = JSON.stringify(queryResults.data)
    } catch (err) {
        logger.error(err)
        throw err
    }
}

const execute = async (req, res) => {
    const response = {
        output: '',
        executeTime: null,
        statusCode: 200,
        memory: null,
        cpuTime: null,
        outputFiles: [],
        compileMessage: '',
        error: 0,
        stdin: req?.stdin,
        errorMessage: '',
    }

    if ([PROMPTV1, PROMPTV2].includes(req.language)) {
        await _getAiScore(
            LANGUAGES_CONFIG[req.language],
            req.question,
            response,
            req.points,
            req.userAnswer,
            req.rubric,
        )
    } else if (req.language === supportedLanguages.SQLITE3) {
        await _executeSqlite3Query(req, res, response)
    } else {
        await _executeCode(req, res, response)
    }
    return response
}

module.exports = { execute }
