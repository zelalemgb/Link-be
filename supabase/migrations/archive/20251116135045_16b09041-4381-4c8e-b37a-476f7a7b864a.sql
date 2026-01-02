-- Refresh the materialized view to pick up current journey stages
REFRESH MATERIALIZED VIEW CONCURRENTLY nurse_dashboard_queue;