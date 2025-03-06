<?php

namespace App\Message;

class MaybeStartProjectMessage {
	public function __construct(
		public readonly string $host
	) {}
}
