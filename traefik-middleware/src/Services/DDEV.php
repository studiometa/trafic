<?php

namespace Studiometa\DdevServer\Services;

use Exception;
use Spatie\Ssh\Ssh;
use Studiometa\DDevServer\Traits\Singleton;

class DDEV {
	use Singleton;

	protected function __construct(
		protected Ssh $client = new Ssh('studiometa', '51.254.39.148')
	) { }

	public static function projects():array {
		$process = self::getInstance()->client->execute('ddev list --json-output');

		if (!$process->isSuccessful()) {
			return [];
		}

		$output = json_decode($process->getOutput(), true);
		return $output['raw'] ?? [];
	}

	public static function start(string $project) {
		$process = self::getInstance()->client->execute("ddev start $project");
		return $process->getOutput();
	}

	public static function stop(string $project) {
		$process = self::getInstance()->client->execute("ddev stop $project");
		return $process->getOutput();
	}
}
