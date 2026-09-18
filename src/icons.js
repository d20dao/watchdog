// The d20dao.org icon set (src/app/icon.svg, favicon.ico and apple-icon.png in the web repo), embedded so the
// Worker needs no asset store. `v` is the first 16 hex digits of the file's SHA-256: the page links each icon with
// it, so a changed icon gets a new URL and the year-long browser cache never keeps an old one.

const bytes = (base64) => Uint8Array.from(atob(base64.replace(/\s+/g, "")), (c) => c.charCodeAt(0));

export const ICONS = Object.freeze({
  "/icon.svg": Object.freeze({
    type: "image/svg+xml",
    v: "54dc50bdacb2da7d",
    body: `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#07090D"/><g transform="translate(116.8 96) scale(1.6)"><g id="D-symbol" fill="#FF2C61"><path d="M0 8L38 38L38 162L0 192Z"/><path d="M0 0L101 0L169 49L132 76L89 40L48 40Z"/><path d="M174 58L174 149L101 200L0 200L48 160L89 160L134 127L134 86Z"/></g></g></svg>`,
  }),
  "/favicon.ico": Object.freeze({
    type: "image/x-icon",
    v: "bda1e0471929d2bd",
    body: bytes(`
    AAABAAMAEBAAAAEAIAAEAQAANgAAACAgAAABACAAsAEAADoBAAAwMAAAAQAgAEkCAADqAgAAiVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf
    8/9hAAAACXBIWXMAADsOAAA7DgHMtqGDAAAAtklEQVQ4y2Ng5+T9TwlmGFwGWAnI/9+u6Pn/v04iHH/XjvtfLGH4n4MYA+LFtP7fVQ/7P1PWHsUQ
    EN6t5PVfjkeUsAEgxf0y1nCxaFGt/9+04sDiB5S9/3Nz8pNmAAhbC8j9nyZn979R2ux/pIgm6QaA8AygASA5kBqyDFgu70K+AYq8Yv+vqgeTZ0CA
    sNr/N1pRYPF3WjH/LQVkyYvGfUre/5V5xclLSNVSJv85OfmGQl4gBwMADx5jNkFgKO4AAAAASUVORK5CYIKJUE5HDQoaCgAAAA1JSERSAAAAIAAA
    ACAIBgAAAHN6evQAAAAJcEhZcwAAOw4AADsOAcy2oYMAAAFiSURBVFjDY2Dn5P0/kJhh1AGjDhjUDrAWkPv/SCPi/3+dRLz4oUb4f0dBReo7YJGc
    4/9YUa3/p1UDCDrit3b8/2Yp8/9cXHzUc8AWJY//f7QT/rdLWfxfJu9M0BEgfFLF/786nwT1HAAzeK2i6/86KdP/f3USCDrig1bM/zhgyFHVASCs
    wCOGocZTWOX/O6CF2BwyV97hPx+XAG0dAMJafJL/b6iFoKj9rh33v1jCkD4OAGFJbuH/+5W9wepAjjHll/0fJar5f4m8E30cAMI8XPz/c8QN/svz
    isITLcgMujkAhHX5pf4/AZYLMD10d0CQsBqKnlEH0N0BCWLaA+eAJDGd/1+14ujvAFAZsFHRHWtpuFnJnbYOsBGQ/39fPQyr5fuUvP8r8YrTvzIC
    FcPVUib/OTn56F8dX1ELAhfDVGuQxADLc2IaJP+AeIqsLcHKh2ZNMhchpdFW8agDRh1AFgYA0oiOvgja3WAAAAAASUVORK5CYIKJUE5HDQoaCgAA
    AA1JSERSAAAAMAAAADAIBgAAAFcC+YcAAAAJcEhZcwAAOw4AADsOAcy2oYMAAAH7SURBVGje7ZhLLwNRFMft6ExnpjpUPdrqmxmLei8QxCPxDuIR
    r9YHsLK0tLeylEhsbCS+gJUFKytiIyJix4JIECKOeyaReDTaTunMJGfx203v3F/m3nP6P3n5NgGsTB4JkAAJkAAJkEC6LLtr4VVNANQsZsxeYAB8
    dpdxAoW8AxZdKgw5Q3CnzOmSuK6egRE5bIxAEV+obWLD2w7NDg9cRCd1Sbwx1j1tIHIOYwSQg9AwxMRy2A8O6pJATiJjUCdVGCOA3LDj0C+HYMvb
    qVviUVnQ7pUhAsizGocEuxfZXG5k198LpbycewFk29f96++aJA9cVU2llMBnupwB8wkgfsEFR+HRlBLnrDC4eaf5BBCJVR189rdjhJvH93CcaD4B
    pICxWtasldJkF7nV4YOz6IT2LlMKfDBbrGgbP42MQz0rpTwnwUpZA7ywooBrml4AwR6Ax6pKdMMh6yuf17SEALJUEoMH9iW+r2kZgXtlPumaJEAC
    JEAC/ysgsMa1VtHypSNbRiAslPxoXJYRmC6qhts08rTpBHAgsOntSHt6YWdHzDQCMakcjln+TbXxJ3VB+0Nns4nWi5QY8BtZcstppMQZT58czCrU
    /8WIxbCxyiXLwN06MrDhgy1kp7In4+xritEiltC4S7HucBenEzReJwESIAESIAES+MQ7MXuBtrmUL+wAAAAASUVORK5CYII=
  `),
  }),
  "/apple-touch-icon.png": Object.freeze({
    type: "image/png",
    v: "62e0de52c2a8cf84",
    body: bytes(`
    iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAYAAAA9zQYyAAAACXBIWXMAADsOAAA7DgHMtqGDAAAIQ0lEQVR42u3dS2xUVRjAcXb0MZ2ZzrQzfU7b
    mXbazhSopELSQJHwKLQUChVaQVowLIg7ohtl6ZKNMRoxcWWCbjAmGJUYCGgkJoohxjcxUTASoxIeUd5yPF9lkulQnJb2du4957/477Sk5UfvfOee
    e+68+cVlisiU5vFDIEATAZoI0ESAJkATAZoI0ESAJgI0AZoI0ESAJgI0EaAJ0ESAJgI0EaCJAE2AJgI0EaCJAE0EaAI0EaCJAE0EaCJAE6CJAE0E
    6NyWBRvU+nCzsfWGEqq0JABIW0B3BKrV2eRWpTp2G9vnLYMq5a8GpS0fOapLw+pkot9o1FdTO9XuSBqYtnyGlsvywViP0ailw41rVLQ0BFBbhsKn
    o4vU7fSY0ajPtQ2rx8obQWoi6LFJLsMbQs3qcupJo1HLP9oXapaqkhI/WE0CfUnDfbNhlQqWBq0bFqWPEhtUvCwKWJNAy1/smeSgavVXWTcsSnI1
    2lmZAq1JoKWLqR2qL5ywcliUDukrVSjnSkUeBi3dSe9S+2u6VJGFw6L0ffJxtSRQD2BTQGd6N96rIjnLWzYMi9KN9Oj4P+riYgZGY0BLP+jfVp2B
    WiuHRelYvF81+CJgNgV05g7bcEWblcOi9Hv7drUp3AJoU0BLd3UHarsnXIJtGhbl+3+5frnylwQBbQLoTEfj68d/O9s4LEpfJ7eoxYE6QJsCWjrf
    NqK6gzErh0XpWmpUPVP1CKBNAS1d16sAe6ILrB0WpXea1t53tQK0R0Fnej22QvmyNs/bNCxKv+hNTqtCcUCbAlo61TwwYWnLpmFR+qdj1/jA6LPg
    qRgrQEsX2kdUT852TJuGRemzlk2qPWcvDKA9CjqzHVPurtk6LEpX9Jr9mMFPxVgFOlPuVlTbhsXMJqdwaTmgTQAt7avqtPbOYqafW4fVCsOeirEW
    9LNVi+/7c8r00LROb0116riCV+rdN4je1B/Dnq82Z5MToOe4vZGF6pYLB9ET+urUVBYBNKCn38ryJvWH3lDkNtR/praroXAroAE9/WT57LvkkGsH
    xnKPPhUD6AJWqVcZ3o+vcyVq+cf2qAefigG0Cw7Pec2ldy0/TPR57ggFQLvo8By3DIvyzKZXzwMBtIuSp9kvFfiupdc3MwHaZaX1CaTynGQhMB9p
    6vX8dlNAc9Lq+N5xeSCgiBsrgHZyWHw1ttw1Z3zIJi5AA9rVJ61O5RSmCr20KA9JyN8BoAE9Kw3M8hZX2UI6OoVz8uRVID+2/rcLEdCAntXkSe6f
    WrfNyqsv8m3yl487smwny3eZ/w/QgHZkWPxYH607k3M78j2GtTBQo05r9Ln/P6AB7UhykMwbsZXTPllpIM9QV3Tv8/pf+giEyb4GoAHtaLLMJg+/
    5vs+j8f7VMxX+b9fq85Xod7Ls6cE0IB2PDnPTga8yb6/W/deZ5Fv4/42fSagbBvN9/MCNKDnpC49LMoLhnIfrVpe3jCl5bip/rwADeg5S84ckSMK
    Mq+Ei+R5JVz2chygAe3K5Cn2jXmO1J1sOQ7QgPZkD1qOAzSgPVW+5ThAA9ozTWU5DtCA9kRTXY4DNKBd3XSX4wANaFf3Yt0yR7aaAhrQBemlekAD
    GtCABjSgAQ1oQAMa0IAGNKABDWhAAxrQgAY0oAENaEADGtCABjSgAQ1oQAMa0IAGNKABDWhAAxrQgAY0oAENaEADGtCABjSgAQ1oQAMa0IAGdGHq
    DNQ69tJOQAN6Tnsq0jHj8+sADeiCV6lPSnqrYbXjL+gENKAdrzsYm/bB5YAGtHLjEbny0qCbDr1hFtCAnrNq9RG5H8TXzxlkQAPasdaGEupC+8ic
    YwY0oGe1zLtRpvJeQkAD2tU1l0XUqeaBgkEGNKBnra0VrepiakfBMQMa0DMqoN/nLS+adwNkQANazfT1a18mN7sKM6AB/VDtjSxUfzt4+3omfdGy
    GdCAdtft64fprk5eQlSu31QLaEC76vb1dPut/Qk1GE56aq0e0Bbdvp5ObzetUdWlYc/dfAK0Rbevp9KV1M7xVyl7dZ8LoC26fZ2vT5s3qnZ/lad3
    IAI6qzJ9i3ldOKHWh5sd6UBtd0FvXz+oG+lR9Vx1lyou9nt+S621oPdVdU74M+Tz4slEvyt/czrZt8khtTRQb8yTO1aCPtSwSgWzlqE6AtXqbHKr
    VZC9thwH6AdcWmVlIftrbwg1q8sOXAHcnCzHbQy3GPnUuzWgf20bUT3ljRO+rkzzt126bOZUhxu9uRwH6Kw+SQyomK9ywv7ig7EeqyDLVWh3JG0s
    ZGtAy+dEnwZs8/B3Qn+/ibKo8ZiNBn1df17eE10w4evYNvzJz2B/jRnLcVaDPq8/L8seCZuHv29ah9QSg5bjrAV9VN9SrioNWTv8yXKcPBzgLwla
    h9ko0PIXKXfisi+vtg1/cmVaE4pbCdko0Ff1hprhijar7/zJclzulQnQHgQtp20u0qdu2jr8yc9mzILlOCtAH2nqVZGc30o2DX/H430qbslynNGg
    76R3jS9HFeX8d7YMfzYuxxkLWs6p6NNbPHNPFrJl+PsquUV1BerAawLoM8lBlfRHrRz+ZB+1LMeVZd31JA+Dzt3yadPwd65tWK22fDnOKNCTTfG2
    DH+yHBdlOc4s0PMtHP7kqjRamQKpyaBtGf6OxftVkz51FKAGg7Zh+LuWYjnOCtA2DH+nWwbHD2oEpQWglwUbHDtawA316rM6fCzH2TsUEgGaAE0E
    aCJAEwGaCNAEaCJAEwGaCNBEgCZAEwGaCNBEgCYCNAGaCNBEgCYCNAGaHwQBmgjQRIAmAjQBmgjQRIAmAjQRoAnQRIAmckf/Aug95BzxXp4cAAAA
    AElFTkSuQmCC
  `),
  }),
});
