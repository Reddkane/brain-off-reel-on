export type Taste = "loved" | "liked" | "meh" | "disliked";

export interface PersonalFields {
  readonly watched?: boolean;
  readonly watched_on?: string;
  readonly taste_rating?: Taste;
  readonly tired_viewing_rating?: number;
}

export interface PersonalState {
  readonly watched: boolean;
  readonly watched_on: string | null;
  readonly taste_rating: Taste | null;
  readonly tired_viewing_rating: number | null;
}

export function fillAbsent(request: PersonalFields, existing: PersonalState | null): {
  status: "conflict";
} | {
  status: "changed" | "unchanged";
  value: PersonalState;
} {
  if (existing &&
    ((request.watched !== undefined &&
      request.watched !== existing.watched) ||
      (request.watched_on !== undefined &&
        existing.watched_on !== null &&
        request.watched_on !== existing.watched_on) ||
      (request.taste_rating !== undefined &&
        existing.taste_rating !== null &&
        request.taste_rating !== existing.taste_rating) ||
      (request.tired_viewing_rating !== undefined &&
        existing.tired_viewing_rating !== null &&
        request.tired_viewing_rating !== existing.tired_viewing_rating))) return {
          status: "conflict"
        };

  const value = {
    watched: request.watched ?? existing?.watched ?? false,
    watched_on: request.watched_on ?? existing?.watched_on ?? null,
    taste_rating: request.taste_rating ?? existing?.taste_rating ?? null,
    tired_viewing_rating: request.tired_viewing_rating ?? existing?.tired_viewing_rating ?? null
  };

  if (value.watched_on !== null && !value.watched) return {
    status: "conflict"
  };

  return {
    status: existing &&
      JSON.stringify(value) === JSON.stringify(existing) ? "unchanged" : "changed",
    value
  };
}
