import { ChatOpenAI } from "@langchain/openai";
import { getSettings } from "../config/settings.js";

// 会议分类、规划、发言与纪要共用模型连接配置。调用方可按场景覆盖温度。
export function createMeetingModel(temperature = getSettings().temperature): ChatOpenAI {
  const settings = getSettings();
  return new ChatOpenAI({
    apiKey: settings.apiKey,
    configuration: { baseURL: settings.baseUrl },
    model: settings.modelName,
    maxTokens: settings.maxTokens,
    temperature,
    modelKwargs: { thinking: { type: "disabled" } },
  });
}
