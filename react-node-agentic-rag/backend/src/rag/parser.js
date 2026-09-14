import crypto from 'node:crypto'
import { extractRawText } from 'mammoth'
import pdfParse from 'pdf-parse/lib/pdf-parse.js'

const TXT_EXT = new Set(['md', 'markdown', 'txt', 'csv', 'json', 'html', 'htm', 'log'])
export const ACCEPT_EXT = new Set([...TXT_EXT, 'pdf', 'docx'])

export const hashBuffer = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

export async function parseFile(filename, buffer) {
  const ext = filename.toLowerCase().split('.').pop()
  if (ext === 'pdf') return clean((await pdfParse(buffer)).text)
  if (ext === 'docx') return clean((await extractRawText({ buffer })).value)
  if (TXT_EXT.has(ext)) {
    const raw = buffer.toString('utf8')
    return clean(ext === 'html' || ext === 'htm' ? stripHtml(raw) : raw)
  }
  throw new Error(`不支持的文件类型: .${ext}`)
}

const clean = (t) => t.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()

const stripHtml = (h) =>
  h
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
