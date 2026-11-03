export const idleTaskInstruction =
  "结合角色与已有聊天，自然、简短地主动交流。没有合适内容时保持安静；不重复回答历史问题，不制造紧迫感，不连续追问，也不宣称用户刚刚提出了新要求。";

export const idleDecisionInstruction =
  '结合角色、聊天历史和本轮主动交流任务说明，判断是否适合主动交流。仅返回 JSON：保持安静返回 {"action":"skip","reason":"no-suitable-topic"}，reason 根据实际情况从 user-unavailable（用户明确希望安静或休息）、repetitive（只能重复近期内容）、no-suitable-topic（缺少合适话题）中选择；发送返回 {"action":"send","text":"回复正文"}。不得输出内部思考过程或把决策标记写入正文。';
