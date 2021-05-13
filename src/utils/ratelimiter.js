import { delay } from "./delay";

export class RateLimiter {
    constructor(
        numRequests,
        interval,
    ) {
        this._numRequests = numRequests;
        this._interval = interval;
        this._slidingWindow = [];
    }

    async wait() {
        let now = Date.now();
        while (this._slidingWindow.length >= this._numRequests) {
            if (now - this._slidingWindow[0] <= this._interval * 1000) {
                await delay(this._interval * 1000 - (now - this._slidingWindow[0]));
                now = Date.now();
            } else {
                this._slidingWindow.shift();
            }
        }
        this._slidingWindow.push(now);
    }
}