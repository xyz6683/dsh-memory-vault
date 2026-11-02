import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { clipChars, clipTokens, estimateTokens } from '../src/budget.ts'

describe('budget', () => {
  it('estimates CJK text conservatively', () => {
    assert.ok(estimateTokens('中文测试') > estimateTokens('abcd'))
    assert.equal(estimateTokens(''), 0)
  })

  it('clips text to a token budget', () => {
    const long = '这是一个很长的中文句子，用来测试裁剪逻辑是否正确工作，需要足够长。'.repeat(10)
    const clipped = clipTokens(long, 30)
    assert.equal(clipped.truncated, true)
    assert.ok(estimateTokens(clipped.text) <= 30)
  })

  it('clips characters with an ellipsis', () => {
    assert.equal(clipChars('hello world', 5), 'hell…')
    assert.equal(clipChars('hi', 5), 'hi')
  })
})
