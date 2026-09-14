import { removeSshKexAlgorithms } from "../hardening.js";
import type { Migration } from "../types.js";

/**
 * Migration 0013: leave SSH key exchange on the OpenSSH defaults.
 *
 * `setup` wrote a `KexAlgorithms curve25519-sha256@libssh.org,...` line into
 * /etc/ssh/sshd_config.d/trafic.conf. Without a `+`, `-` or `^` prefix that
 * directive replaces OpenSSH's default list rather than adding to it, and the
 * two algorithms named are classical only. The post-quantum hybrids OpenSSH
 * enables by itself — mlkem768x25519-sha256 and sntrup761x25519-sha512 — were
 * therefore excluded, so an OpenSSH 10.1+ client prints a warning on every
 * connection that the session is not using a post-quantum key exchange and
 * may be vulnerable to "store now, decrypt later" attacks. Confirmed via
 * `sshd -T` on Ubuntu 26.04 with OpenSSH 10.2.
 *
 * `hardenSsh` no longer writes the line, which covers fresh installs. Servers
 * set up by an earlier release still carry it, so this migration removes it
 * from the existing drop-in. Ciphers and MACs are left pinned — neither is
 * involved in the warning.
 *
 * Idempotent: the helper does nothing when the drop-in is missing or already
 * free of the line, and restores the file when `sshd -t` rejects the result.
 */
export const migration0013SshKexDefaults: Migration = {
  id: "0013__ssh_kex_defaults",
  description: "Remove the KexAlgorithms pin from the SSH drop-in",

  run(): void {
    removeSshKexAlgorithms();
  },
};
