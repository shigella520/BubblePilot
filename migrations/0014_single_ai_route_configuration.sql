-- Provider routes keep one current configuration. The version counter remains
-- an optimistic-concurrency token, not a history of past route definitions.
DELETE FROM ai_provider_route_versions version_row
USING ai_provider_routes route
WHERE version_row.route_id = route.id
  AND version_row.id <> route.current_version_id;
