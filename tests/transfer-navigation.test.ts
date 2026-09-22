/**
 * زنجیرهٔ بازگشتِ جریان انتقال پول.
 *
 * ریشهٔ این آزمون یک رفتار واقعی بود: انتقال بیشتر وقت‌ها با ریپلای روی پیام
 * بازیکن در گروه آغاز می‌شود، ولی دکمهٔ «لغو» و صفحهٔ «انجام شد» بازیکن را به
 * *پنل بانک* می‌بردند — جایی که او هرگز از آن نیامده بود. بازگشتِ درست،
 * زمینهٔ قبلیِ همان جریان است، نه یک بخشِ والدِ تصادفی.
 *
 * قرارداد این آزمون:
 *   لغو → راهنمای انتقال → بانک
 *   انجام‌شده → دفتر مالی (یا بستن)، نه پنل بانک
 */
import { join } from 'path'
import { InlineKeyboard } from 'grammy'
import { readText } from './helpers/source'
import {
  buildTransferCancelledKeyboard,
  buildTransferConfirmKeyboard,
  buildTransferDoneKeyboard,
  buildTransferHelpKeyboard
} from '../src/bot/keyboards/main.keyboard'

function callbacksOf(keyboard: InlineKeyboard): string[] {
  return keyboard.inline_keyboard
    .flat()
    .flatMap((button) => ('callback_data' in button ? [button.callback_data] : []))
}

describe('بازگشتِ جریان انتقال، زمینهٔ خودش را حفظ می‌کند', () => {
  test('پنل تأیید: فقط تأیید و لغو — بی دکمهٔ پرش', () => {
    const callbacks = callbacksOf(buildTransferConfirmKeyboard('tok-1'))
    expect(callbacks).toContain('transfer:confirm:tok-1')
    expect(callbacks).toContain('transfer:cancel')
    expect(callbacks).not.toContain('bank:main')
  })

  test('پس از لغو: بازگشت به قدم قبلی (راهنمای انتقال)، نه پنل بانک', () => {
    const callbacks = callbacksOf(buildTransferCancelledKeyboard())
    expect(callbacks).toContain('transfer:help')
    expect(callbacks).not.toContain('bank:main')
    expect(callbacks).toContain('panel:close')
  })

  test('پس از انجام: قدم بعدی دفتر مالی است، نه پنل بانک', () => {
    const callbacks = callbacksOf(buildTransferDoneKeyboard())
    expect(callbacks).toContain('ledger:0')
    expect(callbacks).not.toContain('bank:main')
  })

  test('راهنمای انتقال — که تنها از پنل بانک باز می‌شود — فقط به بانک برمی‌گردد', () => {
    const callbacks = callbacksOf(buildTransferHelpKeyboard())
    expect(callbacks).toEqual(expect.arrayContaining(['bank:main', 'panel:close']))
  })
})

describe('هر دکمهٔ این جریان به یک هندلر واقعی می‌رسد', () => {
  const source = ['bot/handlers/text.handler.ts', 'bot/handlers/expansion.handler.ts']
    .map((file) => readText(join(__dirname, '..', 'src', file)))
    .join('\n')

  test('پیشوندها و مقصدهای زنجیره در سورس ثبت شده‌اند', () => {
    expect(source).toContain("bot.callbackQuery('transfer:cancel'")
    expect(source).toContain("bot.callbackQuery('transfer:help'")
    expect(source).toMatch(/bot\.callbackQuery\(\/\^transfer:confirm:\//)
    expect(source).toMatch(/bot\.callbackQuery\(\/\^ledger:/)
    expect(source).toContain('buildTransferCancelledKeyboard')
    expect(source).toContain('buildTransferDoneKeyboard')
  })
})
