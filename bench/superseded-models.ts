// The model the `#20`–`#25` bench logs were produced with, kept so their provenance is readable.
//
// Nothing can be sent to it any more: the transport allows `typesafe/jev` and refuses everything
// else, in the CLI and here alike. The scripts below still compile and still parse their saved
// logs; asked to run, they stop at the first request with the refusal's reason. That is the point
// — a bench that quietly reaches for a second model is how the second model got in.
export const SUPERSEDED_PLANNING_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
