// eslint-disable-next-line unicorn/prefer-node-protocol -- node:crypto does not resolve correctly in browser and edge runtime
import * as crypto from 'crypto';
import type { IncomingMessage } from 'node:http';
// When bundled via a bundler supporting the `browser` field, then
// the `undici` module will be replaced with https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API
// for browser contexts. See ./undici-browser.js and ./package.json
import { requestUrl } from 'obsidian';
import type { BlobCommandOptions } from './helpers';
import { BlobError, getTokenFromOptionsOrEnv } from './helpers';
import { createPutMethod } from './put';
import type { PutBlobResult } from './put';

// client.put()
export interface ClientPutCommandOptions {
  access: 'public';
  token: string;
  contentType?: string;
}

export const put = createPutMethod<ClientPutCommandOptions>({
  allowedOptions: ['contentType'],
  extraChecks(options: ClientPutCommandOptions) {
    if (typeof window === 'undefined') {
      throw new BlobError(
        'client/`put` must be called from a client environment',
      );
    }

    if (!options.token.startsWith('vercel_blob_client_')) {
      throw new BlobError('client/`put` must be called with a client token');
    }

    if (
      // @ts-expect-error -- Runtime check for DX.
      options.addRandomSuffix !== undefined ||
      // @ts-expect-error -- Runtime check for DX.
      options.cacheControlMaxAge !== undefined
    ) {
      throw new BlobError(
        'addRandomSuffix and cacheControlMaxAge are not supported in client uploads. Configure these options at the server side when generating client tokens.',
      );
    }
  },
});

// upload()
// This is a client-side wrapper that will fetch the client token for you and then upload the file
export interface UploadOptions {
  /**
   * Whether the blob should be publicly accessible. Support for private blobs is planned.
   */
  access: 'public';
  /**
   * Defines the content type of the blob. By default, this value is inferred from the pathname. Sent as the 'content-type' header when downloading a blob.
   */
  contentType?: string;
  /**
   * A route that implements the `handleUpload` function for generating a client token.
   */
  handleUploadUrl: string;
  /**
   * Additional data which will be sent to your `handleUpload` route.
   */
  clientPayload?: string;
}

/**
 * Uploads a blob into your store from the client.
 * Detailed documentation can be found here: https://vercel.com/docs/storage/vercel-blob/using-blob-sdk#client-uploads
 *
 * If you want to upload from your server instead, check out the documentation for the put operation: https://vercel.com/docs/storage/vercel-blob/using-blob-sdk#upload-a-blob
 *
 * @param pathname - The pathname to upload the blob to. This includes the filename.
 * @param body - The contents of your blob. This has to be a supported fetch body type https://developer.mozilla.org/en-US/docs/Web/API/fetch#body.
 * @param options - Additional options.
 */
export const upload = createPutMethod<UploadOptions>({
  allowedOptions: ['contentType'],
  extraChecks(options: UploadOptions) {
    if (typeof window === 'undefined') {
      throw new BlobError(
        'client/`upload` must be called from a client environment',
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Runtime check for DX.
    if (options.handleUploadUrl === undefined) {
      throw new BlobError('Missing `handleUploadUrl` parameter');
    }

    if (
      // @ts-expect-error -- Runtime check for DX.
      options.addRandomSuffix !== undefined ||
      // @ts-expect-error -- Runtime check for DX.
      options.cacheControlMaxAge !== undefined
    ) {
      throw new BlobError(
        'addRandomSuffix and cacheControlMaxAge are not supported in client uploads. Configure these options at the server side when generating client tokens.',
      );
    }
  },
  async getToken(pathname: string, options: UploadOptions) {
    const clientToken = await retrieveClientToken({
      handleUploadUrl: options.handleUploadUrl,
      pathname,
      clientPayload: options.clientPayload,
    });
    return clientToken;
  },
});

async function importKey(token: string): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function signPayload(
  payload: string,
  token: string,
): Promise<string | undefined> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Node.js < 20: globalThis.crypto is undefined (in a real script.js, because the REPL has it linked to the crypto module). Node.js >= 20, Browsers and Cloudflare workers: globalThis.crypto is defined and is the Web Crypto API.
  if (!globalThis.crypto) {
    return crypto.createHmac('sha256', token).update(payload).digest('hex');
  }

  const signature = await globalThis.crypto.subtle.sign(
    'HMAC',
    await importKey(token),
    new TextEncoder().encode(payload),
  );
  return Buffer.from(new Uint8Array(signature)).toString('hex');
}

async function verifyCallbackSignature({
  token,
  signature,
  body,
}: {
  token: string;
  signature: string;
  body: string;
}): Promise<boolean> {
  // callback signature is signed using the server token
  const secret = token;
  // Browsers, Edge runtime and Node >=20 implement the Web Crypto API
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Node.js < 20: globalThis.crypto is undefined (in a real script.js, because the REPL has it linked to the crypto module). Node.js >= 20, Browsers and Cloudflare workers: globalThis.crypto is defined and is the Web Crypto API.
  if (!globalThis.crypto) {
    // Node <20 falls back to the Node.js crypto module
    const digest = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');
    const digestBuffer = Buffer.from(digest);
    const signatureBuffer = Buffer.from(signature);

    return (
      digestBuffer.length === signatureBuffer.length &&
      crypto.timingSafeEqual(digestBuffer, signatureBuffer)
    );
  }

  const verified = await globalThis.crypto.subtle.verify(
    'HMAC',
    await importKey(token),
    hexToArrayByte(signature),
    new TextEncoder().encode(body),
  );
  return verified;
}

function hexToArrayByte(input: string): ArrayBuffer {
  if (input.length % 2 !== 0) {
    throw new RangeError('Expected string to be an even number of characters');
  }
  const view = new Uint8Array(input.length / 2);

  for (let i = 0; i < input.length; i += 2) {
    view[i / 2] = parseInt(input.substring(i, i + 2), 16);
  }

  return Buffer.from(view);
}

export type DecodedClientTokenPayload = Omit<
  GenerateClientTokenOptions,
  'token'
> & {
  validUntil: number;
};

export function getPayloadFromClientToken(
  clientToken: string,
): DecodedClientTokenPayload {
  const [, , , , encodedToken] = clientToken.split('_');
  const encodedPayload = Buffer.from(encodedToken ?? '', 'base64')
    .toString()
    .split('.')[1];
  const decodedPayload = Buffer.from(encodedPayload ?? '', 'base64').toString();
  return JSON.parse(decodedPayload) as DecodedClientTokenPayload;
}

const EventTypes = {
  generateClientToken: 'blob.generate-client-token',
  uploadCompleted: 'blob.upload-completed',
} as const;

interface GenerateClientTokenEvent {
  type: (typeof EventTypes)['generateClientToken'];
  payload: { pathname: string; callbackUrl: string; clientPayload?: string };
}
interface UploadCompletedEvent {
  type: (typeof EventTypes)['uploadCompleted'];
  payload: {
    blob: PutBlobResult;
    tokenPayload?: string;
  };
}

export type HandleUploadBody = GenerateClientTokenEvent | UploadCompletedEvent;

type RequestType = IncomingMessage | Request;

export interface HandleUploadOptions {
  body: HandleUploadBody;
  onBeforeGenerateToken: (
    pathname: string,
    clientPayload?: string,
  ) => Promise<
    Pick<
      GenerateClientTokenOptions,
      | 'allowedContentTypes'
      | 'maximumSizeInBytes'
      | 'validUntil'
      | 'addRandomSuffix'
      | 'cacheControlMaxAge'
    > & { tokenPayload?: string }
  >;
  onUploadCompleted: (body: UploadCompletedEvent['payload']) => Promise<void>;
  token?: string;
  request: RequestType;
}

export async function handleUpload({
  token,
  request,
  body,
  onBeforeGenerateToken,
  onUploadCompleted,
}: HandleUploadOptions): Promise<
  | { type: GenerateClientTokenEvent['type']; clientToken: string }
  | { type: UploadCompletedEvent['type']; response: 'ok' }
> {
  const resolvedToken = getTokenFromOptionsOrEnv({ token });

  const type = body.type;
  switch (type) {
    case 'blob.generate-client-token': {
      const { pathname, callbackUrl, clientPayload } = body.payload;
      const payload = await onBeforeGenerateToken(pathname, clientPayload);
      const tokenPayload = payload.tokenPayload ?? clientPayload;

      return {
        type,
        clientToken: await generateClientTokenFromReadWriteToken({
          ...payload,
          token: resolvedToken,
          pathname,
          onUploadCompleted: {
            callbackUrl,
            tokenPayload,
          },
        }),
      };
    }
    case 'blob.upload-completed': {
      const signatureHeader = 'x-vercel-signature';
      const signature = (
        'credentials' in request
          ? request.headers.get(signatureHeader) ?? ''
          : request.headers[signatureHeader] ?? ''
      ) as string;

      if (!signature) {
        throw new BlobError('Missing callback signature');
      }

      const isVerified = await verifyCallbackSignature({
        token: resolvedToken,
        signature,
        body: JSON.stringify(body),
      });

      if (!isVerified) {
        throw new BlobError('Invalid callback signature');
      }
      await onUploadCompleted(body.payload);
      return { type, response: 'ok' };
    }
    default:
      throw new BlobError('Invalid event type');
  }
}

async function retrieveClientToken(options: {
  pathname: string;
  handleUploadUrl: string;
  clientPayload?: string;
}): Promise<string> {
  const { handleUploadUrl, pathname } = options;
  const url = isAbsoluteUrl(handleUploadUrl)
    ? handleUploadUrl
    : toAbsoluteUrl(handleUploadUrl);

  const event: GenerateClientTokenEvent = {
    type: EventTypes.generateClientToken,
    payload: {
      pathname,
      callbackUrl: url,
      clientPayload: options.clientPayload,
    },
  };

  const res = await requestUrl({
    url,
    method: 'POST',
    body: JSON.stringify(event),
    headers: {
      'content-type': 'application/json',
    },
  });

  if (res.status >= 400) {
    throw new BlobError('Failed to  retrieve the client token');
  }

  try {
    const { clientToken } = (await res.json) as { clientToken: string };
    return clientToken;
  } catch (e) {
    throw new BlobError('Failed to retrieve the client token');
  }
}

function toAbsoluteUrl(url: string): string {
  return new URL(url, window.location.href).href;
}

function isAbsoluteUrl(url: string): boolean {
  try {
    return Boolean(new URL(url));
  } catch (e) {
    return false;
  }
}

export async function generateClientTokenFromReadWriteToken({
  token,
  ...argsWithoutToken
}: GenerateClientTokenOptions): Promise<string> {
  if (typeof window !== 'undefined') {
    throw new BlobError(
      '"generateClientTokenFromReadWriteToken" must be called from a server environment',
    );
  }

  const timestamp = new Date();
  timestamp.setSeconds(timestamp.getSeconds() + 30);
  const readWriteToken = getTokenFromOptionsOrEnv({ token });

  const [, , , storeId = null] = readWriteToken.split('_');

  if (!storeId) {
    throw new BlobError(
      token ? 'Invalid `token` parameter' : 'Invalid `BLOB_READ_WRITE_TOKEN`',
    );
  }

  const payload = Buffer.from(
    JSON.stringify({
      ...argsWithoutToken,
      validUntil: argsWithoutToken.validUntil ?? timestamp.getTime(),
    }),
  ).toString('base64');

  const securedKey = await signPayload(payload, readWriteToken);

  if (!securedKey) {
    throw new BlobError('Unable to sign client token');
  }
  return `vercel_blob_client_${storeId}_${Buffer.from(
    `${securedKey}.${payload}`,
  ).toString('base64')}`;
}

export interface GenerateClientTokenOptions extends BlobCommandOptions {
  pathname: string;
  onUploadCompleted?: {
    callbackUrl: string;
    tokenPayload?: string;
  };
  maximumSizeInBytes?: number;
  allowedContentTypes?: string[];
  validUntil?: number;
  addRandomSuffix?: boolean;
  cacheControlMaxAge?: number;
}
