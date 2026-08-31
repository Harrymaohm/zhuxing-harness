// mammoth 官方未发布 @types/mammoth，这里手动声明浏览器端用到的 API。
declare module 'mammoth' {
  export interface MammothMessage {
    type: 'warning' | 'error'
    message: string
  }
  export interface MammothResult {
    value: string
    messages: MammothMessage[]
  }
  export interface MammothOptions {
    /** 默认有注释的 styleMap 是否包含；置为 true 可去掉默认样式。 */
    includeDefaultStyleMap?: boolean
    styleMap?: string[]
    ignoreEmptyParagraphs?: boolean
    convertImage?: unknown
  }
  export type MammothInput =
    | { arrayBuffer: ArrayBuffer }
    | { path: string }
    | { buffer: Buffer }
  export function convertToHtml(
    input: MammothInput,
    options?: MammothOptions,
  ): Promise<MammothResult>
  export function convertToMarkdown(
    input: MammothInput,
    options?: MammothOptions,
  ): Promise<MammothResult>
  export function extractRawText(
    input: MammothInput,
    options?: MammothOptions,
  ): Promise<MammothResult>
  const mammoth: {
    convertToHtml: typeof convertToHtml
    convertToMarkdown: typeof convertToMarkdown
    extractRawText: typeof extractRawText
  }
  export default mammoth
}
