<?php

namespace App\Action;

use App\Service\DDEV;
use App\Service\Redis;

class MaybeStartProjectInBackgroundAction {
	public function __construct(
		private Redis $redis,
		private DDEV $ddev,
	) {}

	public function execute(string $host) {
		if ($host && $this->redis->exists($host)) {
          $project = json_decode($this->redis->get($host), true);
          $project_name = $project['name'];
          $project['last_accessed_at'] = time();
          if ($project['status'] !== 'running') {
            echo "Starting $project_name..." . PHP_EOL;
            echo $this->ddev->start($project_name);
          }

          $this->redis->set($host, json_encode($project));
          echo "updating $host..." . PHP_EOL;
        }
	}
}
