import { AppError, type AppServicesClient, type ServiceInvocation, type UiLocale } from "@reai/app-sdk/v1";
import { VoiceAdmissionError } from "./voice-request-admission";
import { voiceServiceMessage } from "./voice-service-messages";
import type { VoiceRequestTextProvider } from "./voice-request-text";
import { structuredCode } from "./voice-error-fields";

export const VOICE_REQUEST_TEXT_SERVICE_ID = "com.reai.voice/request-text@1";

/** 在 activate 注册窗口调用；locale 只读消费 Host，错误返回时读取当前语言。 */
export function registerVoiceRequestTextService(services: AppServicesClient, provider: VoiceRequestTextProvider, locale: () => UiLocale): void {
  const handlers: Record<string, (invocation: ServiceInvocation) => unknown> = {
    "request-text": (invocation) => provider.request(invocation),
    status: ({ caller, input }) => provider.status(caller, input),
    finish: ({ caller, input }) => provider.finish(caller, input),
    cancel: ({ caller, input }) => provider.cancel(caller, input),
  };
  for (const [method, handler] of Object.entries(handlers)) {
    services.provide(VOICE_REQUEST_TEXT_SERVICE_ID, method, async (invocation) => {
      try {
        if (invocation.signal.aborted) throw new VoiceAdmissionError("SERVICE_CANCELLED");
        if (method !== "request-text" && (!invocation.input || typeof invocation.input !== "object"
          || Array.isArray(invocation.input) || Object.keys(invocation.input).some((key) => key !== "requestId"))) {
          throw new VoiceAdmissionError("VOICE_REQUEST_INVALID");
        }
        return await handler(invocation);
      } catch (error) {
        // 交回调用方的码只用登记过的值（§6.0 白名单），其余归到通用的服务失败码。
        const code = structuredCode(error && typeof error === "object" && "code" in error ? error.code : undefined)
          ?? "SERVICE_PROVIDER_FAILED";
        throw new AppError({ code, userMessage: voiceServiceMessage(locale(), code), retryable: code === "SERVICE_BUSY" });
      }
    });
  }
}
