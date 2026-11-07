import {describe,it,expect} from 'vitest'
import {decoderResourceFailure} from './decode'
describe('decoder resource errors',()=>{
 it('does not classify known allocation failures as damaged source media',()=>{
  for(const message of ['D3D11 0x8007000E','Not enough memory resources are available','Out of memory','decoder resource exhausted'])expect(decoderResourceFailure(new Error(message))).toBe(true)
  expect(decoderResourceFailure(new DOMException('allocation failed','QuotaExceededError'))).toBe(true)
  expect(decoderResourceFailure(new Error('Invalid NAL unit'))).toBe(false)
 })
})
