import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import fixtures from './fixtures.json' with { type: 'json' }

/**
 * 「P2-1 五条主流程」的界面级回归。
 *
 * 断言口径统一为「用户能看到的行为」，而不是「点了哪些按钮」：
 * 流式是否逐步上屏、停止后内容是否冻住、刷新后停止按钮是否被补挂回来、
 * 终端是否真的跑出命令输出、文件预览弹窗里是否真的渲染出文件内容。
 */

/** 助手消息正文容器（Markdown 结论渲染处）。 */
const ASSISTANT_CONTENT = '.msg.assistant .assistant-content'

/** 第 index 个流式分片的可断言文本。 */
function chunkLabel(index: number): string {
  return `${fixtures.streamChunkPrefix}${String(index).padStart(4, '0')}${fixtures.streamChunkSuffix}`
}

function composer(page: Page): Locator {
  return page.getByPlaceholder(/输入任务描述/)
}

async function sendTask(page: Page, text: string): Promise<void> {
  const box = composer(page)
  await box.fill(text)
  await box.press('Enter')
}

test.describe('Web 前端五条主流程', () => {
  test('1. 发任务看流式：回复逐段出现，最终形成完整答复', async ({ page }) => {
    await page.goto('/')
    await sendTask(page, fixtures.chatUserMessage)

    const reply = page.locator(ASSISTANT_CONTENT).last()
    // 第一个分片先独自出现
    await expect(reply).toContainText(chunkLabel(1))

    const early = await reply.innerText()
    // 关键证据：此刻结尾哨兵还没到，说明正文不是最后一次性「啪」地出现
    expect(early).not.toContain(fixtures.streamEnd)
    const earlyLength = early.length
    await page.waitForTimeout(400)
    const laterLength = (await reply.innerText()).length
    expect(laterLength).toBeGreaterThan(earlyLength)

    // 流结束后形成完整回复，并被判定为一次正常交付
    await expect(reply).toContainText(fixtures.streamEnd)
    await expect(page.locator('.msg.assistant .delivery')).toContainText('交付完成')
  })

  test('2. 停止：流式进行中点停止后内容不再增长，界面回到可继续输入', async ({ page }) => {
    await page.goto('/')
    await sendTask(page, fixtures.chatUserMessage)
    const reply = page.locator(ASSISTANT_CONTENT).last()
    await expect(reply).toContainText(chunkLabel(1))

    await page.getByRole('button', { name: '停止' }).click()

    // 界面复位：输入框重新可用、发送按钮回来
    await expect(page.getByRole('button', { name: '发送' })).toBeVisible()
    await expect(composer(page)).toBeEnabled()

    // 已停：越过正文 60ms 合并窗口的最后一次写回后，内容不再增长
    await page.waitForTimeout(600)
    const stopped = await reply.innerText()
    await page.waitForTimeout(600)
    expect(await reply.innerText()).toBe(stopped)
    // 而且确实停在半途，不是等它整段跑完才「停」
    expect(stopped).not.toContain(fixtures.streamEnd)
  })

  test('3. 刷新补挂：刷新后「停止」被重新挂上且可用', async ({ page }) => {
    await page.goto('/')
    await sendTask(page, fixtures.chatUserMessage)
    await expect(page.locator(ASSISTANT_CONTENT).last()).toContainText(chunkLabel(1))

    await page.reload()

    // 刷新后内存里的 runId 已丢失，界面必须向服务端问回在跑的轮次：
    // 输入框重新不可用（界面仍处于「运行中」态），且「停止」被挂回来
    await expect(composer(page)).toBeDisabled()
    const stop = page.getByRole('button', { name: '停止' })
    await expect(stop).toBeEnabled()
    // 真的可用：点下去能停（界面回到可输入状态），而不是一个点了没反应的按钮
    await stop.click()
    await expect(page.getByRole('button', { name: '发送' })).toBeVisible()
    await expect(composer(page)).toBeEnabled()
  })

  test('4. 终端执行：工作区面板里执行命令并拿到输出', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: '终端与预览' }).click()

    const input = page.getByPlaceholder(/输入命令/)
    await input.fill(fixtures.terminalCommand)
    await input.press('Enter')

    await expect(page.locator('.xd-entry-out')).toContainText(fixtures.terminalMarker)
    await expect(page.locator('.xd-status')).toContainText('exit 0')
  })

  test('5. 预览文件：点开文件链接后弹窗显示文件内容', async ({ page }) => {
    await page.goto('/')
    await sendTask(page, fixtures.previewUserMessage)

    await page.getByRole('button', { name: fixtures.previewFileName }).click()

    const dialog = page.getByRole('dialog', { name: '文件预览' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(fixtures.previewFileName)
    await expect(dialog).toContainText(fixtures.previewFileContent)
  })
})
