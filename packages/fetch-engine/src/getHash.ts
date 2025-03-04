import fs from 'fs'

export function getHash(filePath: string): Promise<string> {
  const hash = globalThis.crypto.createHash('sha256')
  const input = fs.createReadStream(filePath)
  return new Promise((resolve) => {
    input.on('readable', () => {
      const data = input.read()
      if (data) {
        hash.update(data)
      } else {
        resolve(hash.digest('hex'))
      }
    })
  })
}
