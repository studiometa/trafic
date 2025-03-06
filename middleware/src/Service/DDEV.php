<?php

namespace App\Service;

use Spatie\Ssh\Ssh;
use Symfony\Component\DependencyInjection\ParameterBag\ParameterBagInterface;

class DDEV {
	private Ssh $client;

	public function __construct(ParameterBagInterface $params) {
		$this->client = Ssh::create(
			$params->get('app.ssh_user'),
			$params->get('app.ssh_host')
		)->usePrivateKey($params->get('app.ssh_key_path'))->disableStrictHostKeyChecking();
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
		return $process->isSuccessful() ? $process->getOutput() : $process->getErrorOutput();
	}

	public function stop(string $project): string {
		$process = $this->client->execute("ddev stop $project");
		return $process->isSuccessful() ? $process->getOutput() : $process->getErrorOutput();
	}
}
