<?php

namespace App\Service;

use Spatie\Ssh\Ssh;

class DDEV {
	private Ssh $client;

	public function __construct() {
		$this->client = (new Ssh(getenv('SSH_USER'), getenv('SSH_HOST')))->usePrivateKey(
			dirname(__DIR__, 2) . '/ssh_key'
		);
	}

	public function projects(): array {
		$process = $this->client->execute('ddev list --json-output');

		if (!$process->isSuccessful()) {
			return [];
		}

		$output = json_decode($process->getOutput(), true);
		return $output['raw'] ?? [];
	}

	public function start(string $project): string {
		$process = $this->client->execute("ddev start $project");
		return $process->getOutput();
	}

	public function stop(string $project): string {
		$process = $this->client->execute("ddev stop $project");
		return $process->getOutput();
	}
}
