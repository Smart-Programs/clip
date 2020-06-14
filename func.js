const fdk = require('@fnproject/fdk')
const axios = require('axios')
const {
    mkdirSync,
    existsSync,
    readFileSync,
    rmdirSync,
    unlinkSync,
} = require('fs')

const ffmpeg = require('fluent-ffmpeg')
const path = require('@ffmpeg-installer/ffmpeg').path
ffmpeg.setFfmpegPath(path)

const cpus = require('os').cpus().length

const { S3, DynamoDB } = require('aws-sdk')

const handler = async (input, ctx) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    ctx.statusCode = 400
    return { error: 'no or invalid input type', received: input }
  }

  const {
    files,
    length,
    accountId,
    clipId,
    gameId,
    subscriber,
    base,
    S3_CONFIG,
    S3_BUCKET,
    DYNAMO_CONFIG
  } = input

  if (
    !files ||
    !base ||
    !length ||
    !accountId ||
    !clipId ||
    !gameId ||
    !S3_CONFIG ||
    !S3_BUCKET
  ) {
    ctx.statusCode = 400
    return { error: 'invalid input', received: input }
  }

  const s3 = new S3(S3_CONFIG)
  let DocumentClient

  if (DYNAMO_CONFIG)
    DocumentClient = new DynamoDB.DocumentClient(DYNAMO_CONFIG)

  if (!existsSync(`/tmp/${accountId}`))
    mkdirSync(`/tmp/${accountId}`, { recursive: true })

  // const base = `https://videocdn.mixer.com/hls/${key}_source`

  const videoParts = files.map((file) => `${base}/${file}`)

  const videoConcat = `${accountId}/${clipId}.ts`
  const videoFile = `${accountId}/${clipId}.mp4`
  const imageFile = `${accountId}/${clipId}.jpg`

  const results = await downloadParts(videoParts)

  const didFail = results.findIndex((value) => value.downloaded === false)

  if (didFail !== -1) {
    if (DocumentClient)
      await to(
        updateClipDocument({
          accountId,
          clipId,
          gameId,
          status: 2,
          DocumentClient,
          subscriber
        })
      )
    return Promise.resolve({
      created: false,
      error: results[didFail]
    })
  }

  const concat = await concatParts(videoParts, videoConcat)

  videoParts.forEach((part) => delete memStore[part])

  const inputImage = new stream.PassThrough(),
    inputVideo = new stream.PassThrough()
  inputImage.end(memStore[videoConcat])
  inputVideo.end(memStore[videoConcat])
  delete memStore[videoConcat]

  const renders = await Promise.all([
    renderImage({
      inputType: 'mpegts',
      input: inputImage,
      outputType: 'mjpeg',
      output: new WMStrm(imageFile)
    }),
    renderVideo({
      inputType: 'mpegts',
      input: inputVideo,
      output: `/tmp/${videoFile}`,
      length
    })
  ])

  const videoCreated =
    renders.findIndex(
        ({ type, created }) => created === true && type === 'video'
    ) !== -1
  const imageCreated =
    renders.findIndex(
        ({ type, created }) => created === true && type === 'image'
    ) !== -1

  if (!videoCreated) {
    if (DocumentClient)
      await to(
        updateClipDocument({
          accountId,
          clipId,
          gameId,
          status: 2,
          DocumentClient,
          subscriber
        })
      )

    return Promise.resolve({
      created: false,
      error: {
        error: `Could not render video.`,
        code: '3300'
      }
    })
  }

  let uploadPromises = [
    uploadFile(videoFile, readFileSync(`/tmp/${videoFile}`), s3, S3_BUCKET),
  ]

  if (imageCreated) {
    uploadPromises.push(
      uploadFile(imageFile, memStore[imageFile], s3, S3_BUCKET)
    )
  }

  const uploads = await Promise.all(uploadPromises)

  delete memStore[imageFile]
  unlinkSync(`/tmp/${videoFile}`)

  if (uploads[0].uploaded === false) {
    if (DocumentClient)
      await to(
        updateClipDocument({
          accountId,
          clipId,
          gameId,
          status: 2,
          DocumentClient,
          subscriber
        })
      )
    return Promise.resolve({
      created: false,
      error: {
        error: `Could not upload video.`,
        code: '4000'
      }
    })
  }

  if (DocumentClient)
    await to(
      updateClipDocument({
        accountId,
        clipId,
        gameId,
        status: 1,
        DocumentClient,
        subscriber
      })
    )

  return Promise.resolve({
      created: true,
      url: `https://smartclips.app/${accountId}/${clipId}`
  })
}

fdk.handle(handler)

module.exports = { handler }

function downloadParts(parts) {
  return Promise.all(parts.map(downloadPart))
}

function downloadPart(part) {
  return new Promise((resolve) => {
    axios
      .get(part, { responseType: 'arraybuffer' })
      .then(({ status, data }) => {
        if (status !== 200) {
          return resolve({
            downloaded: false,
            error: `Mixer returned bad status on video: ${status}`,
            code: '3200'
          })
        } else {
          memStore[part] = data

          resolve({ downloaded: true })
        }
      })
      .catch((error) => {
        return resolve({
          downloaded: false,
          error: `Server returned bad status: ${
            error.response ? error.response.status : 'No Status'
          }`
        })
      })
  })
}

function concatParts(parts, filename) {
  return new Promise((resolve) => {
    const file = parts.reduce(
      (p, c) => Buffer.concat([p, memStore[c]]),
      Buffer.from('')
    )

    memStore[filename] = file

    resolve(file)
  })
}

/**
 * MEMORY STREAM
 */

const stream = require('stream')
const util = require('util')
const Writable = stream.Writable

let memStore = {}

function WMStrm(key, options) {
  if (!(this instanceof WMStrm)) {
    return new WMStrm(key, options)
  }
  Writable.call(this, options)
  this.key = key
  memStore[key] = Buffer.from('')
}
util.inherits(WMStrm, Writable)

WMStrm.prototype._write = function (chunk, enc, cb) {
  let buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc)

  memStore[this.key] = Buffer.concat([memStore[this.key], buffer])
  cb()
}

/**
 * RENDER FUNCTIONS
 */

function renderImage({
    inputType = 'mpegts',
    outputType = 'mjpeg',
    input,
    output,
}) {
  return new Promise((resolve) => {
    ffmpeg()
      .addInput(input)
      .inputFormat(inputType)
      .addOutputOptions(['-vframes 1'])
      .on('error', (e) =>
        resolve({ created: false, error: e, type: 'image' })
      )
      .on('end', () => resolve({ created: true, type: 'image' }))
      .toFormat(outputType)
      .output(output)
      .run()
  })
}

function renderVideo({ input, inputType = 'mpegts', output, length }) {
  return new Promise((resolve) => {
    ffmpeg()
      .addInput(input)
      .inputFormat(inputType)
      .addOutputOptions([
        '-threads ' + cpus,
        '-c copy',
        '-bsf:a aac_adtstoasc',
        '-async 1',
        '-t ' + length
      ])
      .on('error', (err) =>
        resolve({ created: false, error: err, type: 'video' })
      )
      .on('end', () => {
        const created = existsSync(output)
        resolve({
          created,
          error: created
            ? null
            : 'File does not exists after render.',
          type: 'video'
        })
      })
      .save(output)
  })
}

/**
 * UPLOAD FUNCTION
 */

function uploadFile(filename, data, s3, Bucket, ACL = 'public-read') {
  return new Promise((resolve) => {
    const params = {
      Bucket,
      Key: filename,
      Body: data,
      ACL
    }

    s3.putObject(params)
      .promise()
      .then((results) => {
        resolve({ uploaded: true, results })
      })
      .catch((error) => {
        resolve({ uploaded: false, error })
      })
  })
}

function updateClipDocument({
    accountId,
    clipId,
    gameId,
    subscriber,
    status,
    DocumentClient,
}) {
  const PK = `ACCOUNT#${accountId}`
  const SK = `#CLIP#${clipId}`

  if (subscriber && status === 1) {
    const part = clipId.substring(0, 4)

    return DocumentClient.update({
      TableName: process.env.DYNAMO_TABLE_NAME,
      Key: {
        PK,
        SK
      },
      UpdateExpression:
        'SET #data.#status = :status, #gsi1pk = :gsi1pk, #gsi1sk = :id, #gsi2pk = :gsi2pk, #gsi2sk = :id, #gsi3pk = :gsi3pk, #gsi3sk = :ulid, #gsi4pk = :gsi4pk, #gsi4sk = :ulid',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#data': 'data',
        '#gsi1pk': 'GSI1PK',
        '#gsi1sk': 'GSI1SK',
        '#gsi2pk': 'GSI2PK',
        '#gsi2sk': 'GSI2SK',
        '#gsi3pk': 'GSI3PK',
        '#gsi3sk': 'GSI3SK',
        '#gsi4pk': 'GSI4PK',
        '#gsi4sk': 'GSI4SK'
      },
      ExpressionAttributeValues: {
        ':status': status,
        ':gsi1pk': `RC#GAME#${gameId}#${part}`,
        ':gsi2pk': `RC#${part}`,
        ':gsi3pk': `PC#GAME#${gameId}`,
        ':gsi4pk': `PC`,
        ':id': clipId,
        ':ulid': '00000000000000000000000000'
      },
      ConditionExpression: 'attribute_exists(PK)'
    }).promise()
  } else {
    return DocumentClient.update({
      TableName: process.env.DYNAMO_TABLE_NAME,
      Key: {
        PK,
        SK
      },
      UpdateExpression: 'SET #data.#status = :status',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#data': 'data'
      },
      ExpressionAttributeValues: {
        ':status': status
      },
      ConditionExpression: 'attribute_exists(PK)'
    }).promise()
  }
}

const to = (promise) => promise.then((r) => [null, r]).catch((e) => [e, null])
