// Brands separate identities at compile time; validated construction belongs to adapters.
declare const movieIdBrand: unique symbol;
declare const streamingProviderIdBrand: unique symbol;
declare const tmdbMovieIdBrand: unique symbol;
declare const tmdbProviderIdBrand: unique symbol;

export type MovieId = string & { readonly [movieIdBrand]: true };
export type StreamingProviderId = string & { readonly [streamingProviderIdBrand]: true };
export type TmdbMovieId = string & { readonly [tmdbMovieIdBrand]: true };
export type TmdbProviderId = string & { readonly [tmdbProviderIdBrand]: true };
