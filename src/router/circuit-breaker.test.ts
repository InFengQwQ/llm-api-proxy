import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CircuitBreaker } from './circuit-breaker.js';

// ---------------------------------------------------------------------------
// CircuitBreaker 单元测试
// ---------------------------------------------------------------------------

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({ failure_threshold: 3, recovery_timeout: 30 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 辅助：记录失败 → 触发熔断打开，然后快进时间到恢复点
  function tripAndAdvance(ms: number): void {
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    expect(breaker.getState()).toBe('open');
    // setSystemTime 从当前时间 + ms
    vi.setSystemTime(Date.now() + ms);
  }

  // ---- 初始状态 ----
  it('should start in closed state', () => {
    expect(breaker.getState()).toBe('closed');
  });

  it('should allow requests when closed', () => {
    expect(breaker.canExecute()).toBe(true);
  });

  // ---- 失败计数 ----
  it('should remain closed below the threshold', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe('closed');
    expect(breaker.canExecute()).toBe(true);
  });

  it('should open after reaching the failure threshold', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure(); // 第 3 次 → open
    expect(breaker.getState()).toBe('open');
  });

  it('should block requests when open', () => {
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    expect(breaker.canExecute()).toBe(false);
  });

  // ---- 恢复探测 ----
  it('should transition to half_open after recovery timeout', () => {
    tripAndAdvance(30_001);
    // canExecute() 触发懒状态转换: open → half_open
    expect(breaker.canExecute()).toBe(true);
    expect(breaker.getState()).toBe('half_open');
  });

  // ---- 成功重置 ----
  it('should reset to closed after a single success in half_open', () => {
    tripAndAdvance(30_001);
    // 触发状态转换
    breaker.canExecute();
    expect(breaker.getState()).toBe('half_open');
    breaker.recordSuccess();
    expect(breaker.getState()).toBe('closed');
  });

  it('should reset to closed after success when below threshold', () => {
    breaker.recordFailure();
    breaker.recordFailure(); // 2 次，未达阈值
    breaker.recordSuccess();
    expect(breaker.getState()).toBe('closed');
  });

  // ---- reset ----
  it('should manually reset to closed', () => {
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    expect(breaker.getState()).toBe('open');
    breaker.reset();
    expect(breaker.getState()).toBe('closed');
  });
});
