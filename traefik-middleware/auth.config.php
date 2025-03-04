<?php

return [
	/**
	 * Configure IPs allowed to access projects without basic auth.
	 */
	'ips' => [
  		'192.168.0.1',
  		'127.0.0.1',
	],
	/**
	 * Configure tokens for the X-DDEV-Auth-Token header.
	 */
	'tokens' => [
		'abcd',
	],
	/**
	 * Configure domains not requiring basic auth.
	 */
	'subdomains' => [
		'example',
	],
	/**
	 * Configure basic auth users and passwords.
	 */
	'users' => [
		'user' => 'password'
	],
];
