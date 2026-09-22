/**
 * Fixtures for the Access tests: a throwaway 2048-bit RSA key pair that stands
 * in for the keys Cloudflare Access publishes. Nothing here is a real secret —
 * it only ever signs tokens inside the test worker.
 */

export const TEST_TEAM_DOMAIN = 'test.cloudflareaccess.com';
export const TEST_AUDIENCE = 'test-aud-tag';
export const TEST_EMAIL = 'jamiesun.net@gmail.com';
export const TEST_KID = 'test-key-1';

const PRIVATE_JWK = {"kty":"RSA","n":"pYvrUih4n4n25RTrBwDqgHgUW0P7WFfCgIr-lvVjpSFnyLwb9Kn1pkkfPRBSYS5RNlRftiiHqhQcB1pzpA6nUlhjQfs7Ns-xcOpmCq9f4wf9s7ml-gMhuogueJMfiVKuCNGKS8qqu_RWH35d0uo5XxHCRjxmOGJgJvFAifAdB4LiZ9B-87Ims3Zh6a1OCftAP8286u3yqAGGy5JCb_9EZBUPXwlDSaf9tLpwEv6eIGoTh6XkDoQQYNeeV7lwrBKicUuF7OG0n3cBaG-RQDsyDAz-qYVP9uJucxbpGUfMTe63bx3erRKbgARLTGlTIgc2SEBBjeuFtGQhziYCreCuGQ","e":"AQAB","d":"GeSNHXAUEcwH8GO5sQI9K3Pcpzu2U-aCFw3mbSEbgUf8ziJR8w4kTGpyduAXKnkOncNLpxemxHzZt3K31KiwFgqaF8deRx_sHn-jDzfH9SAaV-KJKdYUj_Ld5eEJFTb33ow7p8getUAtukZPEX6uE4cZDlhDGr2UUXL5h7mlKLfZFcl8o6T5EztXtqEa4JWa90909EtY5AuqedS6D7gP713D4s-e4MWAybmL5aQD32E8ZYYvm7qN2oNmMfoWe_Jrp-ugDHtkVBt3aWQpst1pO8ufdt1-wSi1Vc5Dh-OaEYKI178NjJssPfqAiDk3x3EgFDZerl_b4wPWSzmKa69Amw","p":"1Xq11JJdX8J3XeYGarxHC7pTemaNAHIxPavCYddfWxMholtCktoCY5HlNFV0EAP6-jvFJiJFJgJxxAAxlIPQU5mBaBjaIoPH-DHAbW98iUrjFegmTun4FTcCuP_YI2xY7PCHSsPQ-53eLiFZ1pXKxIwDTTeSsoIenEcE92ff2vM","q":"xoUfGbASlukYBDPIN1AKGnNCvDLUbFAMPHMos5GXXcYJzx_vQWCwsHHrIgMY298YGym5Ldw1SSt7M2dYTBd0IRs2nlgCGye2ykG4kMP3tfLHZ1nQ2Mzk_eDFH4AD4j6ctmupA5SGcf06PjdXdnAEdrJf3w2SEn9DFDFIoyZLPcM","dp":"EbGyEIRxKNa9fhLqxT4FxXsUIDkPxtGwMyRhYCqxxKK5TvOxeOqI-CfHj6blj85Epyj9FkQQ5y2csFozwdOLGOLITxCARAwYLwIwqOFsuRRz7gTn5_KMlXWRzDOofockd78X96JzV-el2rz47UhNHi1cuLG6fwE5-EoKp1b8vvE","dq":"uzQDrOydyxOKI0RVdNuUe3bfoqtoJ6-gqkyKQDN2AubijyB1NTihxfHXIp67DXQmvk6tInL7CMHpDwNQf4jKaQHJkq45ZjQgKkCpdFJoQHrt0ScgS6GD-2i_WsIUZ4BVtax2mDqyQcHi75KudrCRdQEmaSfZ7Hl33w3OipNs9pM","qi":"r_Bil-cKkSDZIQDa2prCp1JkqoQEWZOUGOUYMpUgAjhGovTEQvWgE9kIV0O8QlVPZAHqs_-9y6JMcmh6B3kBdbFcKPaszAr-x2H8nqTJsckNpfFwI69NQNqAFYT_btuf5G5tMJquOPsuDMio10b11vTauYPRpnvfQpEUU3DtGyY","kid":"test-key-1","alg":"RS256","use":"sig"};

const PUBLIC_JWK = {"kty":"RSA","n":"pYvrUih4n4n25RTrBwDqgHgUW0P7WFfCgIr-lvVjpSFnyLwb9Kn1pkkfPRBSYS5RNlRftiiHqhQcB1pzpA6nUlhjQfs7Ns-xcOpmCq9f4wf9s7ml-gMhuogueJMfiVKuCNGKS8qqu_RWH35d0uo5XxHCRjxmOGJgJvFAifAdB4LiZ9B-87Ims3Zh6a1OCftAP8286u3yqAGGy5JCb_9EZBUPXwlDSaf9tLpwEv6eIGoTh6XkDoQQYNeeV7lwrBKicUuF7OG0n3cBaG-RQDsyDAz-qYVP9uJucxbpGUfMTe63bx3erRKbgARLTGlTIgc2SEBBjeuFtGQhziYCreCuGQ","e":"AQAB","kid":"test-key-1","alg":"RS256","use":"sig"};

export function jwks() {
  return { keys: [PUBLIC_JWK] };
}

function base64Url(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Mints an assertion shaped like the ones Access injects as a request header. */
export async function signAccessJwt(
  options: {
    email?: string;
    aud?: string[];
    expSeconds?: number;
    kid?: string;
    commonName?: string;
    iss?: string;
    omitExp?: boolean;
  } = {},
  now = Date.now(),
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'jwk',
    PRIVATE_JWK,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const header = base64Url(JSON.stringify({ alg: 'RS256', kid: options.kid ?? TEST_KID, typ: 'JWT' }));
  const claims: Record<string, unknown> = {
    aud: options.aud ?? [TEST_AUDIENCE],
    iss: options.iss ?? `https://${TEST_TEAM_DOMAIN}`,
    iat: Math.floor(now / 1000) - 5,
    email: options.email,
    common_name: options.commonName,
    sub: 'test-subject',
    type: 'app',
  };
  if (!options.omitExp) claims.exp = Math.floor(now / 1000) + (options.expSeconds ?? 600);
  const payload = base64Url(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}
