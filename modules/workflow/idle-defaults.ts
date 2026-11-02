export const idleTaskInstruction =
  "优先结合角色与已有聊天，自然、简短地开启轻松话题；历史话题结束不代表不能主动交流。用户明确希望安静、只能重复近期内容或确实没有合适话题时保持安静；不重复回答历史问题，不制造紧迫感，不连续追问，也不宣称用户刚刚提出了新要求。";

export const idleDecisionInstruction =
  '本轮已满足程序设定的主动交流条件。优先结合角色和聊天自然开启轻松话题；历史话题已结束不单独构成跳过理由。尊重用户明确的休息或勿扰意愿，避免重复近期内容。不必寻找未完成任务，不制造紧迫感。仅返回 JSON：发送返回 {"action":"send","text":"回复正文"}；只有不适合交流时返回 {"action":"skip","reason":"user-unavailable"}，reason 从 user-unavailable（用户明确希望安静或休息）、repetitive（只能重复近期内容）、no-suitable-topic（缺少合适话题）中选择。不得输出内部思考过程或把决策标记写入正文。';
