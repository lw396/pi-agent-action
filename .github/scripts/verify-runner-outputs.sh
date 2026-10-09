#!/usr/bin/env bash
# Checks the outputs of one agent-mode run of the action (test-runner.yml).
# Reads CONCLUSION, EXECUTION_FILE and SESSION_ID from the environment.
set -euo pipefail

echo "Conclusion: ${CONCLUSION}"
echo "Execution file: ${EXECUTION_FILE}"
echo "Session id: ${SESSION_ID}"

fail() {
  echo "❌ $1"
  exit 1
}

[ "${CONCLUSION}" = "success" ] || fail "conclusion is '${CONCLUSION}', not 'success'"
[ -n "${SESSION_ID}" ] || fail "session_id is empty"
[ -s "${EXECUTION_FILE}" ] || fail "execution file is missing or empty"
jq -e 'type == "array"' "${EXECUTION_FILE}" > /dev/null ||
  fail "execution file is not a JSON array"
jq -e --arg id "${SESSION_ID}" '.[0].type == "session" and .[0].id == $id' \
  "${EXECUTION_FILE}" > /dev/null ||
  fail "execution file does not start with the session header"
jq -e 'any(.[]; .type == "agent_settled")' "${EXECUTION_FILE}" > /dev/null ||
  fail "execution file has no agent_settled event"

# Token usage and cost of every model response, as reported by pi.
jq -r '
  [.[] | select(.type == "message_end" and .message.role == "assistant")
       | .message.usage] as $usage
  | if ($usage | length) == 0 then error("no assistant message_end events")
    else "Responses: \($usage | length), tokens: \($usage | map(.totalTokens) | add), cost: $\($usage | map(.cost.total) | add)"
    end
' "${EXECUTION_FILE}" || fail "execution file has no usage for the model's responses"

echo "✅ Runner outputs are valid"
