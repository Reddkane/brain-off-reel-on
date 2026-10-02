// Compile only in the independent pure project. Each ambient leak must fail.
// @ts-expect-error -- browser globals are unavailable in pure code
void window;
// @ts-expect-error -- browser globals are unavailable in pure code
void document;
// @ts-expect-error -- Node globals are unavailable in pure code
void process;
// @ts-expect-error -- network globals are unavailable in pure code
void fetch;
export {};
