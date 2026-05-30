import type { CircuitBreakerConfig } from '../config/index.js';

type CircuitState = 'closed' | 'open' | 'half_open';

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private lastFailureAt = 0;
  private readonly threshold: number;
  private readonly recoveryMs: number;

  constructor(config: CircuitBreakerConfig) {
    this.threshold = config.failure_threshold;
    this.recoveryMs = config.recovery_timeout * 1000;
  }

  /** 记录一次成功 */
  recordSuccess(): void {
    this.failureCount = 0;
    this.state = 'closed';
  }

  /** 记录一次失败 */
  recordFailure(): void {
    this.failureCount++;
    this.lastFailureAt = Date.now();
    if (this.failureCount >= this.threshold) {
      this.state = 'open';
    }
  }

  /** 判断是否允许请求通过 */
  canExecute(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureAt >= this.recoveryMs) {
        this.state = 'half_open';
        return true;
      }
      return false;
    }
    // half_open: 允许一个请求探测
    return true;
  }

  getState(): CircuitState {
    return this.state;
  }

  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
  }
}