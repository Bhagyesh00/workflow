import { X509Certificate } from 'node:crypto';
import net, { type AddressInfo } from 'node:net';
import { Duplex } from 'node:stream';
import tls from 'node:tls';
import { HttpClient } from '@workflow/core';
import type { DataObject } from '@workflow/workflow';
import mysql from 'mysql2';
import ssh2 from 'ssh2';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mysqlPool } from '../src/nodes/apps/sql/MySql.node';
import { postgresPool } from '../src/nodes/apps/sql/Postgres.node';
import { contextFor } from './contexts';
import { runNode } from './harness';
import { localHttp } from './servers';
import { type SshServer, startSshServer } from './ssh-server';

// Test-only TLS fixtures: a CA, a server certificate for localhost and a client certificate signed by it, plus an unrelated CA. Generated once; never used outside tests.
const CA_CERT = `-----BEGIN CERTIFICATE-----
MIIDBzCCAe+gAwIBAgIUPJSs7CdFg/ebUYp6HTQ105MH6u4wDQYJKoZIhvcNAQEL
BQAwEjEQMA4GA1UEAwwHVGVzdCBDQTAgFw0yNjExMDYwODQ2MDhaGA8yMTI2MTAx
MzA4NDYwOFowEjEQMA4GA1UEAwwHVGVzdCBDQTCCASIwDQYJKoZIhvcNAQEBBQAD
ggEPADCCAQoCggEBALW5MuotVWdqlheR/itwp8JecXrS3Snl5LkK9To5QCXpmnVF
6Pt2OrkjWAeB2OGRtOhgAvW5Ch4eDArwIrS0FM7R5w+ZdAgFfjaBhYKd9bsToXyi
47IrfQhNBPXewvfAuupgeXsNJPLlenrCYpR4GfIudobVoLVE5IInOcOlg+RsURN9
z7aHDbVe43Sp38jD9OE330SgDabRzK2AiXih+M1ypA6w9BzeBD6APW1rKejjlgak
RqF7v0YQ03RK3+1FdZM5qz+o+cYR5oDBa65AMZXq1f4GLU8jESLI+2pnS9ThkL7p
ii9nKA/DeXp8f+gHtByMAVG0+cDZh95dvr3EArcCAwEAAaNTMFEwHQYDVR0OBBYE
FAzA2KInu2hE09AwaAHeGkhZUgi1MB8GA1UdIwQYMBaAFAzA2KInu2hE09AwaAHe
GkhZUgi1MA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAEmEeDg5
Poif/jPatcdrpDzqTXX2ziaEAkYijSHYIug4ujqbssn8QJmwdze4IV/gZtvDyEbs
RUyHm93Iu318ZrWKMmYI5GFaddPIVTtfExGUL7OxAN6pbcSxV3IcqUPe5T/SgQXZ
y+z02CiUQ3/ZyKdGf7Uzyrn3PUaslum5q34IwVx7FNjhn3XzCy42jwFX5SDz5LmJ
tFIOynDUsExmNP/C7bbRN8SIdIVrGjMZvdWinNiVVjKCpOb1nYO7yoatHGRUcrYK
WVX9lIyUu76ussKYZ6ThAqzbwk5Jb3sBXz4wKr/roTewHTw9fq0nEJSUzGTRLz3p
AYQtgQy6iSuZW3o=
-----END CERTIFICATE-----
`;
const OTHER_CA_CERT = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUBm2pfI2mBDfxt+bhxjauQkgMXwAwDQYJKoZIhvcNAQEL
BQAwEzERMA8GA1UEAwwIT3RoZXIgQ0EwIBcNMjYxMTA2MDg0NjA4WhgPMjEyNjEw
MTMwODQ2MDhaMBMxETAPBgNVBAMMCE90aGVyIENBMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA1b6e8Upz/bOLGpAP+W9p3TnXt+BKLbhi7yWuE9HgXgOY
3MTAlg6kgm/MiYYZo2j+GRTg43oG2moLMzijxOmG01GNETohWgj6g6oxrVVVQvWK
Ci4t6Hy5Kn13ncyLv4eAUakb3CNPNEslaZBf5JgmTm60eEQHM3T0Y3fkWtgF2og0
kGJ2x9/9HIbnUCBjQKQIA9rlarQ9pkxYVdK105Z0+/Axe40/r0U5mbIpwKUN/9H2
ILND1ZBHgm1+N+RtT9IxjLHmY326psA6Zr29ddu6nIvclqlTkorwXrm4Fc65WAZc
/D1NKzRCCzbT3XMxZ2E/vPqb1hIMtWo4LDQb3GfyqwIDAQABo1MwUTAdBgNVHQ4E
FgQUautmIDMzZI16ci5zALCvFTG2rr0wHwYDVR0jBBgwFoAUautmIDMzZI16ci5z
ALCvFTG2rr0wDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAFOkB
HRS64uSguxM/JoX6DYlit1yAQuBUO/LJisaE/E0IcXyg0d8S+JJIwm7uNuc0OqF1
uneeJcQo4nIBKngZN3Y+BowWkGU1YsW0a95X1qmUSjJT67MXu0Myn8Uq4tDNVoVK
vOgXgddFjb9HLTHBmlawjaTWp3DdskZEwqYkDRJLHxqzdWdzF5euty8hdfQyv8/r
TdomkrpncpWRj2UDBMeT0Pg4fy561JTmNW7K32CsPmEhp3544WGgTQP61xE/JHZE
v4QwkAc27w0tpsP/8Z/lnWszSzDKjMayh5aO2XEdTpI7fL1iJ/N/z4nx+G1Y/PNz
bePqiBICdTFbbr//SQ==
-----END CERTIFICATE-----
`;
const SERVER_CERT = `-----BEGIN CERTIFICATE-----
MIIDFDCCAfygAwIBAgIUZMziMGKsS0Z9xCFtVnkPadbZBEMwDQYJKoZIhvcNAQEL
BQAwEjEQMA4GA1UEAwwHVGVzdCBDQTAgFw0yNjExMDYwODQ2MDhaGA8yMTI2MTAx
MzA4NDYwOFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA4xyqzhJL6BY2luWOtgD2tbtQ+xUZISTY5yAMY32xg2IZ
1hhvG/jS5cAA0jljmAfS7ZVtDSjhUP9I9HK1P33ZZuCvbtqzgNI3tVIZKC0MlRYs
x+UTq97CsOrVOjz6fIRPd0v9OW4W2ALRDDT0X7mdGkz6A4QJIxBJEuOx+8A2ccrT
wzSooShuNjS/I+00dfWM4r+iYHrwmov7G2DFrJJTK+TLrfYQuj+Jm1KqqzcOiN3O
QVt1wSppbBxLN8qKYr9sT4XU8R3frUG6GjI6DI7sB9BNfTYROFJUDNEY7a2oanKl
SO1+6bWB7KNyd1yEJvQshApdxFZmaaTSNmDgT7CAGQIDAQABo14wXDAaBgNVHREE
EzARgglsb2NhbGhvc3SHBH8AAAEwHQYDVR0OBBYEFL7xh9XoOTC3+fhEBCzuj8l/
lf7iMB8GA1UdIwQYMBaAFAzA2KInu2hE09AwaAHeGkhZUgi1MA0GCSqGSIb3DQEB
CwUAA4IBAQB8E9cJnbTVS8vYes1xVasfXXc+d2ro/MXLovFbBtpAJPbJsnvWH+/M
zvX0OwgF7WJcDMqwZ7vyXOI3DpoLHlms+5p8m8SpQIflWVnaxSWNfXzghxo/8Ck1
WX9YVydlW21MpmVJJMSrAprssMOY9XofimYiS9R3RCNThnXoi/MTbNDoDkrEhXGh
ZoHMPCZihn1CwV45Nf+FWQJzgCrzWoK6bvxiv0i5ge3SCUpNARu1gNXEc/KPqqIM
91UC1ljQftOjgNSp5Gk90VmjU84iRL2JmYwlKLpv5wQWCFuOjBNZBK9lKAWYOo+R
ol8312FMA5n6B9X4N+HqWixoxneO2oDf
-----END CERTIFICATE-----
`;
const SERVER_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDjHKrOEkvoFjaW
5Y62APa1u1D7FRkhJNjnIAxjfbGDYhnWGG8b+NLlwADSOWOYB9LtlW0NKOFQ/0j0
crU/fdlm4K9u2rOA0je1UhkoLQyVFizH5ROr3sKw6tU6PPp8hE93S/05bhbYAtEM
NPRfuZ0aTPoDhAkjEEkS47H7wDZxytPDNKihKG42NL8j7TR19Yziv6JgevCai/sb
YMWsklMr5Mut9hC6P4mbUqqrNw6I3c5BW3XBKmlsHEs3yopiv2xPhdTxHd+tQboa
MjoMjuwH0E19NhE4UlQM0RjtrahqcqVI7X7ptYHso3J3XIQm9CyECl3EVmZppNI2
YOBPsIAZAgMBAAECggEAbPSm2QAcHHbzr4bn5VcnBN6dpidkC+uSh6dvahe2HtLk
lDraqy+/deucOT7BEgHG5qZGUAbpuaMPi/6wB4rHzrxCTctsTIQNp9aALS8Xlzqx
NyEmQ9E11AyFSVBR14TeXtw82t1+5hjL07BgAMCapzCAzUj93S2F8SL9k0qOlB4T
zzcvY13Tv/xccfD83yAldnHb+yLT2QbSNSg5W60VIRcS3VlJQ8eFr7h158J6nv4X
t2xw3r1Anad72696qxCD6rA+DSLLl6mr47kVr8A6aUmLnmLXIVBWIchLiKpbOEeo
/20zHen/80jzb7niD55uPVC8Rbr7f23Mr6jQUrZZZQKBgQD76LW+t0aF2DLHeDsk
dKs3zOAPkB62y3fdBIasAj1n/LXLeTgCs2FM14GBVodk9AbaxbHAT6qXO9KiUPjl
p7vcURZ1nzyN9RKvqO2oCJOwbqbb7b4jh6ZxAgzI7IeBUqsQdj8GK1nfO+lP3iLD
lzRXrNbtpXFBoNwXXxe6MIgtmwKBgQDmzN2eiVSAI9ayNPIYNiQ2ufP5do2PS5/5
jA5P7Q/XcB/ZNZzFwX1n9zOUZj7wL+DWkNbvvYOjCabqsIP/Ci3rJQDmjy0X0w8i
kI8FBqUDa7qDue9D14Ok8srpzbDltrV4gwAA6dQRgxD1Q+RynrX0vnT2PnG1mUem
ap+gsuJ+WwKBgCXoQOEwJzag8BNALnYv8Ev3UohFAbo0KBdkRPfBZogtaRXzadBO
OggcLerOoJU6e4WUVklAM8WKRQoT8UBt20EuGpkcmzopdORmIU017TORkx5pSkGC
ejNrQY1CuqllTUSu5pEBGQcUtulD3itcp43B/p3IVaCwmi4SKznjb7qdAoGAfaOw
UQk5MrhPu5sO3xc6B4Cay4Y58XOdll8ju2a1ZPXooHmK6iw2dE4hiftO77lgj+0w
1Dk6W5p5fvCwKjoEXSk7oEb4qSt/5bUD5hyD36TZV7P0B95eD4EL7NLIJYScrQnD
Crw/cXkD1kArMCotqxmy2gmMJOtYEcOhOf2nRlkCgYEA95DphEL3V5jwIiSZdWRS
nKYMrdbQz+CE+ZvfpXdEYrBImY0YlNbabL+6nw9+I0qPC3XCLorMwQ2bQbvL89UF
h8YBTMenEaOfms5YwUOFUkl7tYyx15ZPMm4OxtlKSXNinsp3dbMbMeacVXqoCBiW
73/+XVQ6dxyc73hMfqsBJUk=
-----END PRIVATE KEY-----
`;
const CLIENT_CERT = `-----BEGIN CERTIFICATE-----
MIIC+DCCAeCgAwIBAgIUZMziMGKsS0Z9xCFtVnkPadbZBEQwDQYJKoZIhvcNAQEL
BQAwEjEQMA4GA1UEAwwHVGVzdCBDQTAgFw0yNjExMDYwODQ2MDlaGA8yMTI2MTAx
MzA4NDYwOVowFDESMBAGA1UEAwwJZGItY2xpZW50MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEApYdHXkszGGm7gwEwgNJ9TGX8TV2evUtNgUNVV3m2v5kK
HrRM/L6wzku2TsUkNhHtah3xUHEuuyIcRXQnNT4tKd8b9in0GD8jBqkDJdQ82jN8
u20awZ9Lk+3MOTz+QZQvp/VMkjor9Hz2dyJEQlzuQOIM/uqZs6rf449vsd5ml/A1
JHVpGiTrm3SDjJFUN+Y9bl++0Elv4j0PHm5nda4E9RejzJb6eWu4+YQTIQm2vYHt
MDMOHkqJeXjDzqXsuN+0qTwewQYm2egHUymSXs8NF14MYL18t/7bgRyqk+nxRVlv
x6YPAShZCSE4F4222nEYq0eAkO84sJjH6uJySHSJYQIDAQABo0IwQDAdBgNVHQ4E
FgQU3AmrzvEvTg8TScwJSMtPg5WnGx0wHwYDVR0jBBgwFoAUDMDYoie7aETT0DBo
Ad4aSFlSCLUwDQYJKoZIhvcNAQELBQADggEBAALScWB9AtRXWRGATNb6o1Dlw3Oi
gx8/b3yovt8g1K4Z5U/HcY9scNNO5hdHlKqtzcE9I++62nfXrVvjMKVTO1T82xRw
3pJIFjZTO5du1vlthht5y9oF/Rdch+iv+nJkiI5iF8sKvBIHeHCnRB6ECtC5FeD9
JubYu7SBt3fhnEhgHgv6eAiaMCk6nORG2gUi5QkNLbRNEMsAvvs1HysY1AUGGaDh
RnzwMI/tIoXA8UtsgckO2nr/0+mfFaqVIVyALHxFAtp1erRLUbqJZ8BQtVhLXGxC
Xc9yMM5CFaJ4R0m+k29MxhYaTmouJpnd9nrmWKLufH98f2gqbyP3DlbkDDE=
-----END CERTIFICATE-----
`;
const CLIENT_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQClh0deSzMYabuD
ATCA0n1MZfxNXZ69S02BQ1VXeba/mQoetEz8vrDOS7ZOxSQ2Ee1qHfFQcS67IhxF
dCc1Pi0p3xv2KfQYPyMGqQMl1DzaM3y7bRrBn0uT7cw5PP5BlC+n9UySOiv0fPZ3
IkRCXO5A4gz+6pmzqt/jj2+x3maX8DUkdWkaJOubdIOMkVQ35j1uX77QSW/iPQ8e
bmd1rgT1F6PMlvp5a7j5hBMhCba9ge0wMw4eSol5eMPOpey437SpPB7BBibZ6AdT
KZJezw0XXgxgvXy3/tuBHKqT6fFFWW/Hpg8BKFkJITgXjbbacRirR4CQ7ziwmMfq
4nJIdIlhAgMBAAECggEABI/lK2firWBSovJwMgi7G9UuvjofkyOFbBPdQQcxfnfb
E8wP2CJwUIs9J9Aepp/ZXYScP0WTTmSLB24DW6AOUhpcVK1E1Ts+PaOAWvVNxQzI
ugiwhVgc1uOlroksD8YkBxrHZLtWNUuRZmirHXIeveqNBaSVHmLN/2FXaH1S8gqJ
GCtKVDqPvs6nES0/xCME+8bXL4qsKfEfmYTbulayNW68YJm6fzULgiCrlx0gntl+
HZQK+jnHezlp+kxDemxNmtDUz6SxVWI0GhPCRmiBKLhO3NXASrERVUdZo79ETGdY
rUafnJs5Uvk2Vsc7dFcfJlSV1q6PvqCpjP5s44TwQQKBgQDpsLmtphRxsr0lTYo2
N5fKNQEZ5XCrTTrn2CR9a7EOFpWGdOMr/HuudP1U/M5b+GIlzGH9wO4PLYZYtIYf
IzGWRrXfo5iyI9qoXdXcWBq1sHf+7fEA2icAsZy0uxs1+d2e4fjWmezdAL87BL7m
76IVGDaQIShjcCJABjg+v6DMsQKBgQC1VLX0/js2JS27CGGnx26kJl4MFAEGiozv
zW8wjqiFm8vykDPGayUEgU/l0jXLPHHhh3B3iqSf2spQx/UaaVBuX+lVVbGhoPbx
tymjXXBoYLPeTYsFoudDrVozajNRbwmR86FCk0NKHaMazX3jAUwpvfoh0776N3Df
LUT8umvzsQKBgQC/duL6aisv6JDeAkSuHShJLNpFHF4Oi80qbUWgWN6Mu2Yw7o29
2TSAgCubOTHd2oiXjXfvzuV9HACJpwaIdm5HQJH8tG4D7ipVbeQtjyX7HKWEAfFG
kHYKNHs+/FnUBG9WoLAfK6gMfnMvaLj8PvPeMqNpvTD5H8OAD1h/2MNnUQKBgQCO
IJ+eL8bpYaq+dotUnpSyRQBiJyvGnMJrE3KbdLXSQ5NPxIdQdprFNTYSxPk1G2OH
ikk06Y6vXSZGuvP6h6FrYfHZ2RkpvqjQPOh+C7cXmPRiwhS9jjoGadHRiuQ+Z/Hw
XC2BqTuM1D4LvBV34IR6E1YDPZzrMpld1HXGQbhrgQKBgQCJEBzO+CFfWp62XWR0
cuuQbf5DCGcwdDd8hCaIbhrAqGhfUNky5zHYrbEc+tqgiqS48PHp88J5jcBEim9L
3INS+vl+kHEimIIDO+5tA4SiGhzrDd1+FtmU226l0QrpzOKJnUBSJ4yGwKWQIvEi
ime/x9ijtGbJthwqiuTIHwCVPA==
-----END PRIVATE KEY-----
`;

const SSH_PASSWORD = 'tunnel-pw-for-tests';
const keyPair = ssh2.utils.generateKeyPairSync('ed25519');
const http = localHttp();

let passwordServer: SshServer;
let keyServer: SshServer;
let mysqlServer: ReturnType<typeof mysql.createServer>;
let mysqlPort = 0;
const mysqlQueries: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

beforeAll(async () => {
  passwordServer = await startSshServer({ password: SSH_PASSWORD });
  keyServer = await startSshServer({ publicKey: keyPair.public });
  mysqlServer = mysql.createServer((conn: any) => {
    conn.serverHandshake({
      protocolVersion: 10,
      serverVersion: '8.0.36-fake',
      connectionId: 1,
      statusFlags: 2,
      characterSet: 8,
      capabilityFlags: 0xffffff,
      authCallback: (_params: unknown, cb: (err: Error | null) => void) => cb(null),
    });
    conn.on('query', (sql: string) => {
      mysqlQueries.push(sql);
      conn.writeTextResult(
        [{ one: '1' }],
        [
          {
            catalog: 'def',
            schema: 'shop',
            table: 't',
            orgTable: 't',
            name: 'one',
            orgName: 'one',
            characterSet: 33,
            columnLength: 384,
            columnType: 253,
            flags: 0,
            decimals: 0,
          },
        ],
      );
    });
    conn.on('error', () => undefined);
  }) as never;
  await new Promise<void>((resolve) => (mysqlServer as any).listen(0, '127.0.0.1', resolve));
  mysqlPort = ((mysqlServer as any)._server.address() as AddressInfo).port;
});

afterAll(async () => {
  await Promise.all([passwordServer.close(), keyServer.close(), http.close()]);
  (mysqlServer as any).close();
});

afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

const tunnelFields = (server: SshServer, extra: DataObject = {}): DataObject => ({
  sshTunnel: true,
  sshAuthenticateWith: 'password',
  sshHost: '127.0.0.1',
  sshPort: server.port,
  sshUser: 'tester',
  sshPassword: SSH_PASSWORD,
  ...extra,
});

const pgCreds = (extra: DataObject = {}) => ({
  postgres: {
    host: '127.0.0.1',
    port: 5432,
    database: 'nodes_test',
    user: 'postgres',
    password: 'postgres',
    ...extra,
  },
});
const myCreds = (extra: DataObject = {}) => ({
  mySql: {
    host: '127.0.0.1',
    port: mysqlPort,
    database: 'shop',
    user: 'app',
    password: 'pw',
    ...extra,
  },
});

const runPg = (creds: Record<string, DataObject>, client: HttpClient = http) =>
  runNode(
    'app.postgres',
    {
      operation: 'executeQuery',
      query: 'select 1 as one',
      options: { connectionTimeout: 3 },
    },
    [{ json: {} }],
    { creds, services: { http: client } },
  );
const runMy = (creds: Record<string, DataObject>, client: HttpClient = http) =>
  runNode(
    'app.mySql',
    {
      operation: 'executeQuery',
      query: 'SELECT 1 AS one',
      options: { connectionTimeout: 3 },
    },
    [{ json: {} }],
    { creds, services: { http: client } },
  );
const loadContext = (type: string, creds: Record<string, DataObject>) =>
  contextFor(type, {}, { creds, services: { http } }).loadOptions();

describe('SSH tunnel', () => {
  it('Postgres connects through the SSH server with a password', async () => {
    const before = passwordServer.forwards.length;
    const r = await runPg(pgCreds(tunnelFields(passwordServer)));
    expect(r.status).toBe('success');
    expect(r.outputs[0]).toEqual([{ one: 1 }]);
    expect(passwordServer.forwards.slice(before)).toContain('127.0.0.1:5432');
  });

  it('Postgres connects through the SSH server with a private key', async () => {
    const before = keyServer.forwards.length;
    const r = await runPg(
      pgCreds(
        tunnelFields(keyServer, {
          sshAuthenticateWith: 'privateKey',
          sshPassword: '',
          // pasted on one line, as in the SSH nodes
          privateKey: keyPair.private.replace(/\n/g, ' '),
        }),
      ),
    );
    expect(r.status).toBe('success');
    expect(r.outputs[0]).toEqual([{ one: 1 }]);
    expect(keyServer.forwards.slice(before)).toContain('127.0.0.1:5432');
  });

  it('MySQL connects through the SSH server', async () => {
    mysqlQueries.length = 0;
    const before = passwordServer.forwards.length;
    const r = await runMy(myCreds(tunnelFields(passwordServer)));
    expect(r.status).toBe('success');
    expect(r.outputs[0]).toEqual([{ one: '1' }]);
    expect(mysqlQueries).toContain('SELECT 1 AS one');
    expect(passwordServer.forwards.slice(before)).toContain(`127.0.0.1:${mysqlPort}`);
  });

  it('a wrong SSH password fails with a text that does not hold the password', async () => {
    const wrong = 'not-the-password-xyz';
    const r = await runPg(pgCreds(tunnelFields(passwordServer, { sshPassword: wrong })));
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/SSH tunnel/);
    expect(JSON.stringify(r.error)).not.toContain(wrong);
    expect(JSON.stringify(r.error)).not.toContain(SSH_PASSWORD);
  });

  it('a private key credential without a key fails before any connection', async () => {
    const before = keyServer.connections;
    const r = await runPg(
      pgCreds(
        tunnelFields(keyServer, {
          sshAuthenticateWith: 'privateKey',
          privateKey: '',
        }),
      ),
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/no private key/);
    expect(keyServer.connections).toBe(before);
  });

  it('the database host is reached from the SSH server: a non-loopback target is refused there', async () => {
    const r = await runPg(pgCreds(tunnelFields(passwordServer, { host: '10.20.30.40' })));
    expect(r.status).toBe('error');
    expect(passwordServer.refusedForwards).toContain('10.20.30.40:5432');
  });

  it.each(['10.0.0.1', '169.254.169.254'])('the SSH host %s goes through the SSRF guard', async (sshHost) => {
    const before = passwordServer.connections;
    const r = await runPg(pgCreds(tunnelFields(passwordServer, { sshHost })), new HttpClient());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('SSRF_BLOCKED');
    expect(passwordServer.connections).toBe(before);
  });

  it('ending the pool closes the tunnel', async () => {
    const pool = await postgresPool(loadContext('app.postgres', pgCreds(tunnelFields(passwordServer))), {
      connectionTimeoutSeconds: 3,
    });
    const tunnelPort = (pool as unknown as { options: { port: number } }).options.port;
    const client = await pool.connect();
    expect((await client.query('select 1 as one')).rows).toEqual([{ one: 1 }]);
    client.release();
    await pool.end();
    const refused = await new Promise<boolean>((resolve) => {
      const probe = net.connect({ host: '127.0.0.1', port: tunnelPort });
      probe.once('connect', () => {
        probe.destroy();
        resolve(false);
      });
      probe.once('error', () => resolve(true));
    });
    expect(refused).toBe(true);
  });

  it('the MySQL pool closes its tunnel too', async () => {
    const pool = await mysqlPool(loadContext('app.mySql', myCreds(tunnelFields(passwordServer))), {
      connectionTimeoutSeconds: 3,
    });
    const tunnelPort = (
      pool as unknown as {
        pool: { config: { connectionConfig: { port: number } } };
      }
    ).pool.config.connectionConfig.port;
    await pool.end();
    const refused = await new Promise<boolean>((resolve) => {
      const probe = net.connect({ host: '127.0.0.1', port: tunnelPort });
      probe.once('connect', () => {
        probe.destroy();
        resolve(false);
      });
      probe.once('error', () => resolve(true));
    });
    expect(refused).toBe(true);
  });
});

interface TlsSeen {
  /** TLS handshakes the server completed */
  secure: number;
  /** common name of the client certificate each completed handshake presented */
  clientCerts: Array<string | undefined>;
  /** whether the client certificate was issued by the test CA */
  authorized: boolean[];
}

const serverContext = tls.createSecureContext({
  key: SERVER_KEY,
  cert: SERVER_CERT,
  ca: CA_CERT,
});

/**
 * Upgrade a raw socket to TLS as the server, asking for a client certificate. `early` is what the
 * client already sent after its plaintext request (MySQL sends the ClientHello right behind it).
 */
function upgrade(socket: net.Socket, early: Buffer): tls.TLSSocket {
  const wire = new Duplex({
    read() {
      socket.resume();
    },
    write(chunk, _encoding, callback) {
      socket.write(chunk, callback);
    },
    final(callback) {
      socket.end(callback);
    },
  });
  socket.on('data', (chunk) => {
    if (!wire.push(chunk)) socket.pause();
  });
  socket.once('end', () => wire.push(null));
  socket.once('close', () => wire.destroy());
  if (early.length) wire.push(early);
  return new tls.TLSSocket(wire, {
    isServer: true,
    secureContext: serverContext,
    requestCert: true,
    rejectUnauthorized: false,
  });
}

function recordSecure(socket: tls.TLSSocket, seen: TlsSeen) {
  socket.on('error', () => undefined);
  socket.once('secure', () => {
    seen.secure++;
    const cert = socket.getPeerCertificate();
    const name = cert && 'subject' in cert && cert.subject ? cert.subject.CN : undefined;
    seen.clientCerts.push(Array.isArray(name) ? name[0] : name);
    const issuedByCa = cert?.raw
      ? new X509Certificate(cert.raw).checkIssued(new X509Certificate(CA_CERT))
      : false;
    seen.authorized.push(issuedByCa);
    socket.end();
  });
}

/** a Postgres endpoint: answers SSLRequest with `S` and upgrades to TLS asking for a client certificate */
async function pgTlsEndpoint(): Promise<{ port: number; seen: TlsSeen }> {
  const seen: TlsSeen = { secure: 0, clientCerts: [], authorized: [] };
  const server = net.createServer((socket) => {
    socket.on('error', () => undefined);
    socket.once('data', (chunk) => {
      // SSLRequest: length 8, code 80877103
      if (chunk.length < 8 || chunk.readInt32BE(4) !== 80877103) return socket.destroy();
      socket.write('S');
      socket.removeAllListeners('data');
      recordSecure(upgrade(socket, Buffer.alloc(0)), seen);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port: (server.address() as AddressInfo).port, seen };
}

/** a MySQL endpoint: greeting with the SSL capability, SSL request packet, then the TLS upgrade */
async function mysqlTlsEndpoint(): Promise<{ port: number; seen: TlsSeen }> {
  const seen: TlsSeen = { secure: 0, clientCerts: [], authorized: [] };
  const CLIENT_SSL = 0x800;
  const base = 0x1 | 0x200 | 0x8000 | 0x80000; // long password, protocol 41, secure connection, plugin auth
  const capabilities = base | CLIENT_SSL;
  const server = net.createServer((socket) => {
    socket.on('error', () => undefined);
    const salt = Buffer.alloc(20, 7);
    const payload = Buffer.concat([
      Buffer.from([10]),
      Buffer.from('8.0.36-tls\0'),
      Buffer.from([1, 0, 0, 0]),
      salt.subarray(0, 8),
      Buffer.from([0]),
      Buffer.from([capabilities & 0xff, (capabilities >> 8) & 0xff]),
      Buffer.from([8]),
      Buffer.from([2, 0]),
      Buffer.from([(capabilities >> 16) & 0xff, (capabilities >> 24) & 0xff]),
      Buffer.from([21]),
      Buffer.alloc(10),
      salt.subarray(8, 20),
      Buffer.from([0]),
      Buffer.from('mysql_native_password\0'),
    ]);
    const header = Buffer.from([payload.length & 0xff, (payload.length >> 8) & 0xff, 0, 0]);
    socket.write(Buffer.concat([header, payload]));
    socket.once('data', (chunk) => {
      // the SSL request is a 4 byte header plus 32 bytes; a TLS ClientHello may follow in the same chunk
      if (chunk.length < 36) return socket.destroy();
      socket.removeAllListeners('data');
      recordSecure(upgrade(socket, chunk.subarray(36)), seen);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port: (server.address() as AddressInfo).port, seen };
}

const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
};

const tlsCreds = (extra: DataObject = {}): DataObject => ({
  ssl: 'require',
  caCertificate: CA_CERT,
  clientPrivateKey: CLIENT_KEY,
  clientCertificate: CLIENT_CERT,
  ...extra,
});

describe.each([
  {
    name: 'Postgres',
    type: 'app.postgres',
    endpoint: pgTlsEndpoint,
    pool: async (port: number, extra: DataObject) => {
      const creds = {
        postgres: {
          host: '127.0.0.1',
          port,
          user: 'u',
          password: 'p',
          ...extra,
        },
      };
      return postgresPool(loadContext('app.postgres', creds), {
        connectionTimeoutSeconds: 3,
      });
    },
    connect: async (pool: any) => (await pool.connect()).release(),
  },
  {
    name: 'MySQL',
    type: 'app.mySql',
    endpoint: mysqlTlsEndpoint,
    pool: async (port: number, extra: DataObject) => {
      const creds = {
        mySql: { host: '127.0.0.1', port, user: 'u', password: 'p', ...extra },
      };
      return mysqlPool(loadContext('app.mySql', creds), {
        connectionTimeoutSeconds: 3,
      });
    },
    connect: async (pool: any) => (await pool.getConnection()).release(),
  },
])('$name TLS client certificate', ({ endpoint, pool: makePool, connect }) => {
  const attempt = async (port: number, extra: DataObject) => {
    const pool = await makePool(port, extra);
    try {
      await connect(pool);
    } catch (error) {
      return error as Error;
    } finally {
      await pool.end().catch(() => undefined);
    }
    return undefined;
  };

  it('presents the client certificate when the server is verified against the CA', async () => {
    const { port, seen } = await endpoint();
    await attempt(port, tlsCreds());
    await waitFor(() => seen.secure > 0);
    expect(seen.secure).toBeGreaterThan(0);
    expect(seen.clientCerts[0]).toBe('db-client');
    expect(seen.authorized[0]).toBe(true);
  });

  it('refuses a server from another CA under verify, without finishing the handshake', async () => {
    const { port, seen } = await endpoint();
    const error = await attempt(port, tlsCreds({ caCertificate: OTHER_CA_CERT }));
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toMatch(/self.signed|unable to (verify|get)|certificate/i);
    expect(seen.secure).toBe(0);
  });

  it('accepts the same server under allow (no verify) and still presents the client certificate', async () => {
    const { port, seen } = await endpoint();
    await attempt(port, tlsCreds({ ssl: 'allow', caCertificate: OTHER_CA_CERT }));
    await waitFor(() => seen.secure > 0);
    expect(seen.secure).toBeGreaterThan(0);
    expect(seen.clientCerts[0]).toBe('db-client');
  });

  it('sends no client certificate when none is set', async () => {
    const { port, seen } = await endpoint();
    await attempt(port, tlsCreds({ clientPrivateKey: '', clientCertificate: '' }));
    await waitFor(() => seen.secure > 0);
    expect(seen.secure).toBeGreaterThan(0);
    expect(seen.clientCerts[0]).toBeUndefined();
  });

  it('takes a client key and certificate pasted on one line', async () => {
    const { port, seen } = await endpoint();
    await attempt(
      port,
      tlsCreds({
        clientPrivateKey: CLIENT_KEY.replace(/\n/g, ' '),
        clientCertificate: CLIENT_CERT.replace(/\n/g, ' '),
      }),
    );
    await waitFor(() => seen.secure > 0);
    expect(seen.clientCerts[0]).toBe('db-client');
  });
});

describe('TLS through the SSH tunnel', () => {
  it('Postgres verifies the server certificate and presents the client certificate through the tunnel', async () => {
    const { port, seen } = await pgTlsEndpoint();
    const creds = {
      postgres: {
        host: '127.0.0.1',
        port,
        user: 'u',
        password: 'p',
        ...tlsCreds(),
        ...tunnelFields(passwordServer),
      },
    };
    const pool = await postgresPool(loadContext('app.postgres', creds), {
      connectionTimeoutSeconds: 3,
    });
    await pool.connect().then(
      (c) => c.release(),
      () => undefined,
    );
    await pool.end();
    await waitFor(() => seen.secure > 0);
    expect(seen.secure).toBeGreaterThan(0);
    expect(seen.clientCerts[0]).toBe('db-client');
  });
});

/** maps made-up host names to 127.0.0.1, so a name that is not in the test certificate can be reached */
class NamedHttp extends HttpClient {
  constructor(private readonly names: Record<string, string>) {
    super({ ssrf: { allow: ['127.0.0.1'] } });
  }
  override resolveAllowedHost(host: string) {
    return super.resolveAllowedHost(this.names[host] ?? host);
  }
}
const named = new NamedHttp({ localhost: '127.0.0.1', 'db.wrong.test': '127.0.0.1' });
const IDENTITY = /altnames|does not match|Hostname\/IP|identity/i;

describe('MySQL checks the host name in the server certificate under require', () => {
  const connectTo = async (host: string, extra: DataObject = {}) => {
    const { port, seen } = await mysqlTlsEndpoint();
    const ctx = contextFor(
      'app.mySql',
      {},
      {
        creds: { mySql: { host, port, user: 'u', password: 'p', ...tlsCreds(extra) } },
        services: { http: named },
      },
    ).loadOptions();
    const pool = await mysqlPool(ctx, { connectionTimeoutSeconds: 3 });
    let error: Error | undefined;
    try {
      (await pool.getConnection()).release();
    } catch (e) {
      error = e as Error;
    } finally {
      await pool.end().catch(() => undefined);
    }
    return { error, seen };
  };

  it('accepts a certificate that is valid for the name the user entered', async () => {
    const { error, seen } = await connectTo('localhost');
    await waitFor(() => seen.secure > 0);
    expect(seen.secure).toBeGreaterThan(0);
    expect(String(error?.message ?? '')).not.toMatch(IDENTITY);
  });

  it('refuses a certificate from the trusted CA that is for another name', async () => {
    const { error, seen } = await connectTo('db.wrong.test');
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toMatch(IDENTITY);
    expect(seen.secure).toBe(0);
  });

  it('does not check the name under allow, which does not verify the server', async () => {
    const { error, seen } = await connectTo('db.wrong.test', { ssl: 'allow' });
    await waitFor(() => seen.secure > 0);
    expect(seen.secure).toBeGreaterThan(0);
    expect(String(error?.message ?? '')).not.toMatch(IDENTITY);
  });

  it('keeps the host the user entered in the pool and sends the TLS options mysql2 reads', async () => {
    const ctx = contextFor(
      'app.mySql',
      {},
      {
        creds: { mySql: { host: 'db.wrong.test', port: 3306, user: 'u', password: 'p', ...tlsCreds() } },
        services: { http: named },
      },
    ).loadOptions();
    const pool = await mysqlPool(ctx, { connectionTimeoutSeconds: 3 });
    const config = (
      pool as unknown as { pool: { config: { connectionConfig: { host: string; ssl: DataObject } } } }
    ).pool.config.connectionConfig;
    await pool.end();
    expect(config.host).toBe('db.wrong.test');
    expect(config.ssl.verifyIdentity).toBe(true);
    expect(config.ssl.rejectUnauthorized).toBe(true);
  });

  it('an IP address as the host leaves the name check off (only the chain is verified)', async () => {
    const ctx = contextFor(
      'app.mySql',
      {},
      {
        creds: { mySql: { host: '127.0.0.1', port: 3306, user: 'u', password: 'p', ...tlsCreds() } },
        services: { http },
      },
    ).loadOptions();
    const pool = await mysqlPool(ctx, { connectionTimeoutSeconds: 3 });
    const config = (pool as unknown as { pool: { config: { connectionConfig: { ssl: DataObject } } } }).pool
      .config.connectionConfig;
    await pool.end();
    expect(config.ssl.verifyIdentity).toBeUndefined();
  });
});

describe('MySQL TLS through the SSH tunnel', () => {
  it('verifies the server certificate and presents the client certificate through the tunnel', async () => {
    const { port, seen } = await mysqlTlsEndpoint();
    const creds = {
      mySql: {
        host: '127.0.0.1',
        port,
        user: 'u',
        password: 'p',
        ...tlsCreds(),
        ...tunnelFields(passwordServer),
      },
    };
    const pool = await mysqlPool(loadContext('app.mySql', creds), { connectionTimeoutSeconds: 3 });
    await pool.getConnection().then(
      (c) => c.release(),
      () => undefined,
    );
    await pool.end();
    await waitFor(() => seen.secure > 0);
    expect(seen.secure).toBeGreaterThan(0);
    expect(seen.clientCerts[0]).toBe('db-client');
  });
});

describe('SSH tunnel failures', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a failure text from the SSH server is not passed on', async () => {
    const serverText = 'Go away, this is the server text with details 10.9.8.7';
    vi.spyOn(ssh2.Client.prototype, 'connect').mockImplementation(function (this: ssh2.Client) {
      queueMicrotask(() => this.emit('error', new Error(serverText)));
      return this;
    });
    const r = await runPg(pgCreds(tunnelFields(passwordServer)));
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/Couldn't open the SSH tunnel to 127\.0\.0\.1:\d+/);
    expect(r.error?.message).toContain("Couldn't complete the SSH handshake");
    expect(JSON.stringify(r.error)).not.toContain('server text');
    expect(JSON.stringify(r.error)).not.toContain('10.9.8.7');
  });

  it('a wrong password and a timeout each give a fixed text', async () => {
    const wrong = await runPg(pgCreds(tunnelFields(passwordServer, { sshPassword: 'nope-nope' })));
    expect(wrong.error?.message).toContain('SSH refused the user name, password or key');
  });

  it('a forward on an SSH connection that is gone closes the local socket and does not throw', async () => {
    vi.spyOn(ssh2.Client.prototype, 'forwardOut').mockImplementation(() => {
      throw new Error('Not connected');
    });
    const pool = await postgresPool(loadContext('app.postgres', pgCreds(tunnelFields(passwordServer))), {
      connectionTimeoutSeconds: 3,
    });
    const uncaught: Error[] = [];
    const onUncaught = (e: Error) => void uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    try {
      await expect(pool.connect()).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      process.off('uncaughtException', onUncaught);
      await pool.end();
    }
    expect(uncaught).toEqual([]);
  });
});
