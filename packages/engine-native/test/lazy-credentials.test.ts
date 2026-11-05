import { expect, test } from "bun:test"
import { createAwsCredentialChain, createAzureEntraCredential, createGoogleAdcCredential } from "../src/lazy-credentials"

test("credential presence stays synchronous and token requests read the current environment", async () => {
  const env: Record<string, string | undefined> = {
    AWS_ACCESS_KEY_ID: "fixtureaccesskey",
    AWS_SECRET_ACCESS_KEY: "fixture-secret-key",
    AZURE_OPENAI_AUTH_TOKEN: "fixture-azure-token",
    GOOGLE_OAUTH_ACCESS_TOKEN: "fixture-google-token",
    GOOGLE_CLOUD_QUOTA_PROJECT: "project-one",
  }
  const fetch = async (): Promise<Response> => { throw new Error("environment credentials must not use the network") }
  const aws = createAwsCredentialChain({ env: () => env, options: {}, region: "us-east-1", fetch })
  const azure = createAzureEntraCredential({ env: () => env, fetch })
  const google = createGoogleAdcCredential({ env: () => env, fetch })
  expect([aws.ready(), azure.ready(), google.ready()]).toEqual([true, true, true])
  expect(google.quotaProject()).toBe("project-one")
  const signal = new AbortController().signal
  expect((await aws.get(signal)).accessKeyId).toBe("fixtureaccesskey")
  expect(await azure.token(signal)).toBe("fixture-azure-token")
  expect(await google.token(signal)).toBe("fixture-google-token")
  env.AWS_ACCESS_KEY_ID = "rotatedaccesskey"
  env.AZURE_OPENAI_AUTH_TOKEN = "rotated-azure-token"
  env.GOOGLE_OAUTH_ACCESS_TOKEN = "rotated-google-token"
  env.GOOGLE_CLOUD_QUOTA_PROJECT = "project-two"
  expect((await aws.get(signal)).accessKeyId).toBe("rotatedaccesskey")
  expect(await azure.token(signal)).toBe("rotated-azure-token")
  expect(await google.token(signal)).toBe("rotated-google-token")
  expect(google.quotaProject()).toBe("project-two")
})

test("concurrent first ADC calls share the resolver's token exchange", async () => {
  let calls = 0
  const google = createGoogleAdcCredential({ env: () => ({}), allowMetadata: true, fetch: async () => {
    calls++
    return Response.json({ access_token: "fixture-token", expires_in: 3600, token_type: "Bearer" })
  } })
  const signal = new AbortController().signal
  expect(await Promise.all([google.token(signal), google.token(signal)])).toEqual(["fixture-token", "fixture-token"])
  expect(calls).toBe(1)
  expect(await google.token(signal)).toBe("fixture-token")
  expect(calls).toBe(1)
})

test("an aborted first request never reaches a credential endpoint", async () => {
  let calls = 0
  const input = { env: () => ({}), fetch: async () => { calls++; throw new Error("unexpected request") } }
  const controller = new AbortController()
  const reason = new Error("cancelled fixture")
  controller.abort(reason)
  const aws = createAwsCredentialChain({ ...input, options: {}, region: "us-east-1" })
  const azure = createAzureEntraCredential(input)
  const google = createGoogleAdcCredential(input)
  await expect(aws.get(controller.signal)).rejects.toBe(reason)
  await expect(azure.token(controller.signal)).rejects.toBe(reason)
  await expect(google.token(controller.signal)).rejects.toBe(reason)
  expect(calls).toBe(0)
})
