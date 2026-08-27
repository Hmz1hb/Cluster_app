// Liveness probe for the ALB target group.
//
// The app has no page at "/" — the frontend is static files under public/ —
// so the load balancer needs an explicit route that returns 200, or every
// task gets killed as unhealthy before it can serve traffic.
export default function handler(req, res) {
  res.status(200).json({ ok: true, service: 'cluster-app' });
}
