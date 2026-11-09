/**
 * The tracking comment one run updates. GitHub keeps review comments and issue
 * comments in separate ID namespaces, so an ID alone can name a different
 * comment than the one the run created.
 */
export type TrackingComment = {
  id: number;
  namespace: "issue" | "review";
};
