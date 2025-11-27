// src/mock/ioredis.ts
export default class Redis {
  constructor() {
    console.warn('ioredis is disabled in browser')
  }
  on() { return this }
  connect() { return Promise.resolve() }
  get() { return Promise.resolve(null) }
  set() { return Promise.resolve('OK') }
  // هر متدی که استفاده می‌کنی رو mock کن
}