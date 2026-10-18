// @ts-check
// LAN ESC/POS printer on TCP 9100 (Day 18): Buffer -> ip:9100, 3 s timeout, retry queue.
import net from 'node:net';

export const TIMEOUT_MS = 3000;

/** @param {string} ip @param {number} port @param {Buffer} buf @param {number} [timeout] @returns {Promise<void>} */
export function sendRaw(ip, port, buf, timeout = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: ip, port });
    let done = false;
    /** @param {Error} [err] */
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => finish(new Error(`printer ${ip}:${port} timeout`)), timeout);
    sock.on('error', (e) => finish(e));
    sock.on('connect', () => sock.end(buf, () => finish()));
  });
}

/**
 * @typedef {{ id: number, label: string, ip: string, port: number, buf: Buffer, tries: number, status: 'queued'|'sent'|'failed', error?: string, ts: number }} Job
 */

export class PrintQueue {
  /** @param {{ retries?: number, retryMs?: number, timeout?: number, onStatus?: (job: Job) => void }} [opts] */
  constructor(opts = {}) {
    this.retries = opts.retries ?? 4;
    this.retryMs = opts.retryMs ?? 5000;
    this.timeout = opts.timeout ?? TIMEOUT_MS;
    this.onStatus = opts.onStatus ?? (() => {});
    /** @type {Job[]} */
    this.jobs = [];
    this.seq = 0;
    /** @type {Set<NodeJS.Timeout>} */
    this.timers = new Set();
    /** Serialize per printer so two KOTs never interleave. @type {Map<string, Promise<any>>} */
    this.lanes = new Map();
  }

  /** @param {{label: string, ip: string, port?: number, buf: Buffer}} j */
  enqueue(j) {
    const job = /** @type {Job} */ ({ id: ++this.seq, label: j.label, ip: j.ip, port: j.port || 9100, buf: j.buf, tries: 0, status: 'queued', ts: Date.now() });
    this.jobs.push(job);
    if (this.jobs.length > 100) this.jobs.splice(0, this.jobs.length - 100);
    this.attempt(job);
    return job;
  }

  /** @param {Job} job */
  attempt(job) {
    const key = `${job.ip}:${job.port}`;
    const prev = this.lanes.get(key) ?? Promise.resolve();
    const next = prev.then(async () => {
      job.tries++;
      try {
        await sendRaw(job.ip, job.port, job.buf, this.timeout);
        job.status = 'sent';
        delete job.error;
        this.onStatus(job);
      } catch (e) {
        job.error = /** @type {Error} */ (e).message;
        if (job.tries > this.retries) {
          job.status = 'failed';
          this.onStatus(job);
        } else {
          const t = setTimeout(() => { this.timers.delete(t); this.attempt(job); }, this.retryMs);
          this.timers.add(t);
        }
      }
    });
    this.lanes.set(key, next);
    return next;
  }

  /** @param {number} id */
  retry(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (job && job.status === 'failed') {
      job.status = 'queued';
      job.tries = 0;
      this.attempt(job);
    }
    return job;
  }

  list() {
    return this.jobs.map(({ buf, ...j }) => ({ ...j, bytes: buf.length }));
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
