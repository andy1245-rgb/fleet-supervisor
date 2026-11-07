// The channel layer's public surface. Everything a caller needs is reachable from here,
// and nothing outside `src/channels/reddit/` reaches into a file inside it directly — the
// layer is meant to be swappable behind this barrel, because the two things that will
// change first (the credential plane and the browser bridge) are the two that are wired
// from outside today.

export type { Availability, RedditChannel } from "./channel.ts";
export { AVAILABLE, CAPABILITIES, capabilitiesOf, toWorkerMode } from "./channel.ts";

export type { Capability, ChannelId, ChannelNote, Cost, Envelope, ErrorCode, FetchOpts, Hit, HitList, RawComment, RawThread, RemovalState, ScopedQuery, ThreadParse, TimeWindow } from "./types.ts";
export { NO_COST, permalinkFor } from "./types.ts";

export type { Diagnosis, Verdict, WallShape } from "./walls.ts";
export { BRANDED_WALL_FLOOR_BYTES, DIAGNOSIS_EFFECT, LOGIN_REDIRECT_PATTERN, classify } from "./walls.ts";

export type { BucketKey, BucketState, Limit, TakeResult } from "./budget.ts";
export { BUCKET_LIMITS, BucketStore, RSS_JITTER_MS, TokenBucket, bandJitter, bucketKeyFor, fullJitter } from "./budget.ts";

export type { AttemptOutcome, FailureClass, HealthPolicy, HealthSnapshot, OutcomeKind, Usable } from "./health.ts";
export { DEFAULT_HEALTH_POLICY, HealthBoard } from "./health.ts";

export type { DependencyProbe, HttpRequest, HttpResponse, NodeTransportOptions, Transport } from "./transport.ts";
export { CHROME_PATH, MEASURED_UA, nodeTransport, probeBrowser, probeCurlCffi, realDependencyProbe } from "./transport.ts";

export type { ArcticFailure } from "./parse-arctic.ts";
export { ARCTIC_BASE, ARCTIC_COMMENT_FIELDS, ARCTIC_POST_FIELDS, ARCTIC_TIMEOUT_RETRY_MS, arcticResetSeconds, mapArcticFailure, parseArcticComments, parseArcticPosts } from "./parse-arctic.ts";

export type { JsonFailure, Listing } from "./parse-json.ts";
export { mapJsonFailure, parseJsonHits, parseJsonThread, unwrapListings } from "./parse-json.ts";

export { rssResetSeconds, scoreFromContent } from "./parse-rss.ts";

export type { IdentityLoad, IdentitySpec, JarCookie, ProbeOutcome, SessionIdentity } from "./identity.ts";
export { SESSION_COOKIE, cookieHeader, loadIdentity, parseNetscapeJar, probeOutcome } from "./identity.ts";

export type { ArcticOptions } from "./arctic.ts";
export { ARCTIC_IDENTITY, ArcticChannel } from "./arctic.ts";

export type { RssOptions } from "./rss.ts";
export { RSS_BASE, RSS_IDENTITY, RssChannel } from "./rss.ts";

export type { JsonOptions } from "./json.ts";
export { JSON_BASE, JsonChannel, redditTimeParam, withinWindow } from "./json.ts";

export type { BrowserBridge, BrowserOptions } from "./browser.ts";
export { BROWSER_BASE, BrowserChannel } from "./browser.ts";

export type { AttemptRecord, Classified, RetryPolicy, RouterOptions, RouterRun } from "./router.ts";
export { CANDIDATES, DEFAULT_RETRY_POLICY, RedditRouter, classifyEnvelope } from "./router.ts";

export type { SingleOutcome, StoredThread, StoreOptions, ThreadLookup } from "./store.ts";
export { RedditStore, TTL_MS, defaultStateDir, projectionKey, searchPageKey, sha256, threadTtlMs } from "./store.ts";

export type { DropReason, ProjectOptions, Projection, Segment, Stance, ThreadCounts } from "./projection.ts";
export { ALGORITHM_VERSION, MIN_BODY_CHARS, MIN_SEGMENT_CHARS, SPEC_TEXT_TARGET, contentTokens, isBot, project, rankComments, stanceOf, threadIdOf, truncateAtSentence } from "./projection.ts";

export type { FetchState, SearchState } from "./worker-state.ts";
export { FETCH_FIELD_CHARS, SEARCH_FIELD_CHARS, WORKER_TEXT_CAP, renderFetchState, renderSearchState } from "./worker-state.ts";

export type { FixtureName } from "./fixtures.ts";
export { FIXTURES, fixture } from "./fixtures.ts";
