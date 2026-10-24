// Entry point. Static files are served by the assets binding without invoking this Worker;
// only /api/* and /health arrive here, and all of them go to the one Tracker object.
export { Tracker } from './tracker.js';

const tracker = (env) => env.TRACKER.get(env.TRACKER.idFromName('main'));

export default {
  fetch: (request, env) => tracker(env).fetch(request),
  // Safety net: restarts the collector after a deploy or eviction even if nobody visits.
  scheduled: (_controller, env) => tracker(env).ensure(),
};
