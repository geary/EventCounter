// EventCounter.ts

// This is an event counter that tracks the number of events that have
// occurred in a time period leading up to the present.
//
// An EventCounter provides a `countEvent` method to count each event, and a
// `getEventCount` method to get the total number of events going back to a
// specified interval before now.
//
// Events do not have anything like an ID or payload; EventCounter simply
// tracks a single counter of all events. Multiple instances of this class
// can be instantiated to track different events separately.
//
// `countEvent` may be called at a very fast rate, even into the millions
// of times per second. The code avoids unnecessary memory allocation and
// garbage collection pressure, by using a pre-allocated circular buffer of
// "buckets" to store event counts.
//
// About circular buffers: https://en.wikipedia.org/wiki/Circular_buffer
//
// By default, the last 5 minutes of events are tracked, and a bucket is one
// second, so there are 300 buckets. The caller can change these values.
//
// Each bucket has a start time and a count of events for its time period.
// Bucket start times are aligned to multiples of the bucket duration. For
// example, with the default bucket duration of 1000 milliseconds, a bucket
// may start at a time of 1576822238000, but not at a time of 1576822238729.
//
// Because of the bucketing, there is some jitter in the value returned by
// `getEventCount`. With the default one-second buckets, the returned count
// may be off by as much as a second's worth of data.
//
// For code as performance-critical as this, it is worth benchmarking a few
// different implementations. The code below is a compromise between
// performance and readability, with as much emphasis on performance as
// possible without sacrificing readability.
//
// The code is likely to be run under V8, so some of the notes below are
// specific to V8 optimizations.
//
// One idea would be to split `buckets` into two separate arrays, an array of
// start times and an array of counts. That may allow V8 to optimize these
// arrays into `PACKED_DOUBLE_ELEMENTS` and `PACKED_SMI_ELEMENTS`,
// instead of the `PACKED_ELEMENTS` that it is likely to use with this
// implementation. OTOH, that may result in worse cache coherency, as most
// calls to `countEvent` should hit the current bucket, where the time and
// count are adjacent in memory in the current implementation.
//
// Another idea is instead of having a start time for each bucket, use
// a simple array of counts, e.g. the default 300 buckets of 1 second each
// would always represent exactly 5 minutes. This would have zero-count
// buckets when there is no activity. The implementation below skips over
// time periods where there is no activity.
//
// If that avenue did prove fruitful, another possible optimization could be
// to use an `ArrayBuffer` with an `Int32Array` view.
//
// Or it may turn out that this is premature optimization and the code below
// iis good enough for now! As always with truly performance critical code,
// experimenting and benchmarking on real live data is key.

// Specific types for times and durations.
type Milliseconds = number;
type Time = Milliseconds;  // An absolute time as returned by `+new Date()`
type Duration = Milliseconds;  // The difference between two Time values

// A single bucket in the circular buffer, representing the number of events
// that occurred in a specific time interval. `startTime` is rounded down to
// the nearest integer multiple of `bucketDuration`.
class Bucket {
	startTime: Time;
	eventCount: number;
}

// A counter of events. This implements the circular buffer of buckets, and
// provides `countEvent` to count an event and `getEventCount` to query
// the recent event count.
export class EventCounter {
	// A circular buffer of buckets:
	private buckets: Bucket[] = [];
	// Index of the current bucket in the buckets array:
	private cursor = 0;
	// The duration of time for a single bucket:
	private bucketDuration: Duration;
	// The entire time limit in history:
	private historyDuration: Duration;

	constructor(
		// Maximum history in milliseconds, default 5 minutes:
		historyDuration: Duration = 5 * 60 * 1000,
		// Duration of a bucket in milliseconds, default 1 second:
		bucketDuration: Duration = 1000,
	) {
		// Calculate the number of buckets and recalculate the history limit.
		// Floor them both so they are consistent integers.
		this.bucketDuration = Math.floor( bucketDuration );
		if( this.bucketDuration <= 0 ) {
			throw new RangeError(
				`EventCounter: bucketDuration ${bucketDuration} is invalid.`
			);
		}
		const bucketCount = Math.floor( historyDuration / this.bucketDuration );
		this.historyDuration = this.bucketDuration * bucketCount;
		if( this.historyDuration < 2 ) {
			throw new RangeError(
				`EventCounter: historyDuration ${historyDuration} and bucketDuration ${bucketDuration} do not make sense.`
			);
		}

		// Pre-fill the buckets array. Do not preallocate the array with
		// `new Array(bucketCount)`! In V8, that creates a "holey" array
		// which is slower than the packed array created by this code.
		for( let i = 0;  i < bucketCount;  ++i ) {
			this.buckets.push({ startTime: 0, eventCount: 0 });
		}
	}

	// Count an event or any number of events passed into `count`.
	// Add this to the current bucket if that bucket is still within its
	// time duration, otherwise move to the next bucket.
	// This method may be called at a very fast rate!
	// Internal note: The buckets array is initialized with a 0 startTime
	// for each element. This lets us avoid special cases in the code.
	// The startTime of 0 insures that when we first start populating events,
	// the initial buckets always look like they are far in the past. So we
	// fill all new buckets the first time through.
	countEvent( count = 1 ) {
		// The first part of this code is the most time-critical.
		const now: Time = +new Date();
		let bucket = this.buckets[this.cursor];
		if( now - bucket.startTime < this.bucketDuration ) {
			// The latest bucket is still current, update it.
			bucket.eventCount += count;
			return;
		}
		// This code only runs when we roll over to a new bucket.
		this.cursor = ++this.cursor % this.buckets.length;
		bucket = this.buckets[this.cursor];
		// Normalize the start time and count the bucket's first event(s).
		bucket.startTime =
			Math.floor( now / this.bucketDuration ) * this.bucketDuration;
		bucket.eventCount = count;
	}

	// Return the number of events that have been counted within a given
	// duration leading up to the present. Because event counts are grouped
	// into buckets, the returned count is accurate only to the level of
	// precision that the buckets provide.
	getEventCount(
		// The length of time to go back from the present:
		duration: Duration
	) {
		if( duration > this.historyDuration ) {
			throw new RangeError(
				`EventCounter.getEventCount: duration ${duration} is greater than history limit ${this.historyDuration}`
			);
		}
		// Scan backward through the circular buffer of buckets, adding the
		// event counts until we reach a bucket before the start time.
		const startTime: Time = +new Date() - duration;
		let count = 0;
		let cursor = this.cursor;
		while( true ) {
			const bucket = this.buckets[cursor];
			if( bucket.startTime < startTime ) break;
			count += bucket.eventCount;
			--cursor;
			if( cursor < 0 ) cursor = this.buckets.length - 1;
			if( cursor === this.cursor ) {
				// Cannot happen! But protect against the impossible.
				throw new RangeError(
					`EventCounter.getEventCount: unexpected infinite loop.`
				)
			}
		}
		return count;
	}
}
