-- Usage rows for csv-reader-speed-01-run-20261121.
-- Build subagent agent_id: ddcfe1e7-9f30-4290-947c-dd7362f0fc90
-- Fix subagent agent_id: bd089903-8e96-4d29-baa9-de3206df7148
-- Parent (side-chat) agent_id: 2870ffdf-7452-44bd-85f9-96964660edf3
SELECT u.agent_id AS agent_id, u.message_id AS message_id, u.created_at AS created_at, u.input_tokens AS input_tokens, u.output_tokens AS output_tokens, a.model AS model FROM agent.agent_message_token_usage u JOIN agent.agents a ON a.agent_id = u.agent_id WHERE u.agent_id IN ('ddcfe1e7-9f30-4290-947c-dd7362f0fc90', '2870ffdf-7452-44bd-85f9-96964660edf3', 'bd089903-8e96-4d29-baa9-de3206df7148') ORDER BY u.created_at DESC LIMIT 500
