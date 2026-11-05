import { awsPresence, entraReady, googlePresence } from "./credential-presence"
import type * as Aws from "./aws-credentials"
import type * as Google from "./google-adc"
import type * as Azure from "./azure-entra"

/** Keep synchronous catalog presence checks separate from token resolution and its caches. */
export function createAwsCredentialChain(input: Parameters<typeof Aws.createAwsCredentialChain>[0]): ReturnType<typeof Aws.createAwsCredentialChain> {
  const presence = awsPresence(input)
  let runtime: ReturnType<typeof Aws.createAwsCredentialChain> | undefined
  return {
    ready: presence.ready,
    async get(signal) {
      const { createAwsCredentialChain } = await import("./aws-credentials")
      runtime ??= createAwsCredentialChain({ ...input, home: presence.home })
      return runtime.get(signal)
    },
  }
}

export function createAzureEntraCredential(input: Parameters<typeof Azure.createAzureEntraCredential>[0]): ReturnType<typeof Azure.createAzureEntraCredential> {
  let runtime: ReturnType<typeof Azure.createAzureEntraCredential> | undefined
  return {
    ready: () => entraReady(input),
    async token(signal) {
      const { createAzureEntraCredential } = await import("./azure-entra")
      runtime ??= createAzureEntraCredential(input)
      return runtime.token(signal)
    },
  }
}

export function createGoogleAdcCredential(input: Parameters<typeof Google.createGoogleAdcCredential>[0]): ReturnType<typeof Google.createGoogleAdcCredential> {
  let runtime: ReturnType<typeof Google.createGoogleAdcCredential> | undefined
  return {
    ready: googlePresence(input).ready,
    quotaProject: () => runtime ? runtime.quotaProject() : input.env().GOOGLE_CLOUD_QUOTA_PROJECT?.trim() || undefined,
    async token(signal) {
      const { createGoogleAdcCredential } = await import("./google-adc")
      runtime ??= createGoogleAdcCredential(input)
      return runtime.token(signal)
    },
  }
}
