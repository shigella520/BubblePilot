<script setup lang="ts">
import { computed } from "vue";
import type { TaskSchedule } from "../../../../../modules/scheduled-tasks/task-schedule";
const props = defineProps<{ disabled?: boolean }>();
const model = defineModel<TaskSchedule>({ required: true });
const ruleType = computed({
  get: () =>
    model.value.kind === "recurring" ? model.value.rule.type : "daily",
  set: (type: string) => {
    if (model.value.kind !== "recurring") return;
    const localTime =
      "localTime" in model.value.rule ? model.value.rule.localTime : "08:00";
    model.value = {
      ...model.value,
      rule:
        type === "interval"
          ? { type, everyMinutes: 180 }
          : type === "weekly"
            ? { type, weekdays: [1, 3, 5], localTime }
            : type === "monthly"
              ? { type, dayOfMonth: 1, localTime }
              : { type: "daily", localTime },
    };
  },
});
const endType = computed({
  get: () =>
    model.value.kind === "recurring" ? model.value.end.kind : "never",
  set: (kind: string) => {
    if (model.value.kind === "recurring")
      model.value = {
        ...model.value,
        end:
          kind === "count"
            ? { kind, count: 10 }
            : kind === "until"
              ? { kind, until: "" }
              : { kind: "never" },
      };
  },
});
</script>
<template>
  <fieldset class="schedule-fields" :disabled="props.disabled">
    <label
      >任务类型<select :value="model.kind" disabled>
        <option value="once">单次提醒</option>
        <option value="recurring">周期提醒</option>
      </select></label
    >
    <label v-if="model.kind === 'once'"
      >执行时间（包含时区偏移）<input
        v-model="model.scheduledAt"
        required
        placeholder="2030-06-09T08:00:00+08:00"
    /></label>
    <template v-else>
      <label
        >生效起点（包含时区偏移）<input
          v-model="model.startsAt"
          required
          placeholder="2030-06-09T08:00:00+08:00"
      /></label>
      <label
        >重复方式<select v-model="ruleType">
          <option value="daily">每天</option>
          <option value="weekly">每周</option>
          <option value="monthly">每月</option>
          <option value="interval">固定间隔</option>
        </select></label
      >
      <div v-if="model.rule.type === 'weekly'" class="weekday-options">
        <label
          v-for="(day, i) in ['一', '二', '三', '四', '五', '六', '日']"
          :key="day"
          ><input
            v-model="model.rule.weekdays"
            type="checkbox"
            :value="i + 1"
          />周{{ day }}</label
        >
      </div>
      <label v-if="model.rule.type === 'monthly'"
        >每月日期<select v-model="model.rule.dayOfMonth">
          <option v-for="n in 31" :key="n" :value="n">{{ n }} 日</option>
          <option value="last">最后一天</option>
        </select></label
      >
      <label v-if="model.rule.type === 'interval'"
        >间隔分钟<input
          v-model.number="model.rule.everyMinutes"
          type="number"
          min="60"
          max="525600"
          required
      /></label>
      <label v-else
        >当地时刻<input v-model="model.rule.localTime" type="time" required
      /></label>
      <label
        >结束条件<select v-model="endType">
          <option value="never">直到取消</option>
          <option value="until">指定截止时间</option>
          <option value="count">指定计划次数</option>
        </select></label
      >
      <label v-if="model.end.kind === 'until'"
        >截止时间（不包含，含时区偏移）<input
          v-model="model.end.until"
          required
          placeholder="2030-07-01T00:00:00+08:00"
      /></label>
      <label v-if="model.end.kind === 'count'"
        >计划次数<input
          v-model.number="model.end.count"
          type="number"
          min="1"
          max="10000"
          required
      /></label>
      <p class="schedule-help">
        失败、过期和主动跳过均计次，暂停期间不计次。不存在的日期／时刻跳过，夏令时重复时刻只提醒一次。修改周期时请设置未来的生效起点。
      </p>
    </template>
  </fieldset>
</template>
<style scoped>
.schedule-fields {
  border: 0;
  padding: 0;
  margin: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.schedule-fields label {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.schedule-fields input,
.schedule-fields select {
  width: 100%;
  min-width: 0;
}
.weekday-options,
.schedule-help {
  grid-column: 1/-1;
}
.weekday-options {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.weekday-options label {
  display: flex;
  align-items: center;
  gap: 6px;
}
.weekday-options input {
  width: auto;
}
.schedule-help {
  font-size: 13px;
  line-height: 1.7;
  opacity: 0.75;
  margin: 0;
}
@media (max-width: 640px) {
  .schedule-fields {
    grid-template-columns: 1fr;
  }
}
</style>
