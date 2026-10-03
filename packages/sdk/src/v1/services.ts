/** Host 从真实调用会话生成；不接受 input 自报的身份。 */
export interface ServiceCaller {
  readonly appId: string;
  readonly surfaceMountId: string;
  readonly runtimeSessionId: string;
  /** 可选的 Host 不透明登录代际；不含 token、账号资料或登录 session secret。 */
  readonly accountGeneration?: string;
  /** Host-issued same-device delegation; never sourced from Service input. */
  readonly external?: { readonly id: string; readonly principal: Readonly<Record<string, unknown>> };
}

export interface ServiceInvocation<TInput = unknown> {
  input: TInput;
  signal: AbortSignal;
  /** 旧 Host 不下发；需要隔离控制调用的 provider 必须对缺失身份 fail closed。 */
  caller?: Readonly<ServiceCaller>;
  /** Host 接受请求时确定的绝对 deadline，包含冷启动时间。 */
  deadlineUnixMs?: number;
}

export type ServiceHandler<TInput = unknown, TOutput = unknown> = (
  invocation: ServiceInvocation<TInput>,
) => TOutput | Promise<TOutput>;

export interface AppServicesClient {
  provide<TInput = unknown, TOutput = unknown>(
    serviceId: string,
    method: string,
    handler: ServiceHandler<TInput, TOutput>,
  ): void;

  call<TOutput = unknown>(
    serviceId: string,
    method: string,
    input: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<TOutput>;
}

export interface GatewayConnection { id: string; endpoint: string; token: string }
export interface GatewayHandle { id: string; serviceId: string; principal: Record<string, unknown> }
export interface AppGatewayClient {
  list(): Promise<GatewayHandle[]>;
  issue(scope: { serviceId: string; methods: string[]; principal: Record<string, unknown> }): Promise<GatewayConnection>;
  revoke(id: string): Promise<void>;
}
