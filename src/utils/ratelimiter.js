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
        while (this._slidingWindow.length > 0 && now - this._slidingWindow[0] > this._interval * 1000) {
            this._slidingWindow.shift();
        }
        if (this._slidingWindow.length >= this._numRequests) {
            if (now - this._slidingWindow[0] <= this._interval * 1000) {
                await delay(this._interval * 1000 - (now - this._slidingWindow[0]));
                this._slidingWindow.shift();
                now = Date.now();
            }
        }
        this._slidingWindow.push(now);
    }
}