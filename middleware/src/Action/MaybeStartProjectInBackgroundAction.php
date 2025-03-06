<?php

namespace App\Action;

use App\Service\DDEV;
use App\Service\Redis;

class MaybeStartProjectInBackgroundAction {
	public function __construct(
		private Redis $redis,
		private DDEV $ddev,
	) {}

	public function execute(?string $host): void {
		if (!$host || !$this->redis->exists($host)) {
			return;
		}

		$project = $this->redis->get($host);
		$project['last_accessed_at'] = time();
		$this->redis->set($host, $project);
		$this->ddev->maybeStartAsync($project['name']);
	}
}
