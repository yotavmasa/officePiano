"""Portable runtime layout and installer-plan tests; no downloads or package changes."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from backend.sheets import audiveris_command, audiveris_runtime
from scripts.install_sheet_tools import install_linux, SOURCE_COMMIT

ROOT = Path(__file__).resolve().parents[1]


class InstallerTests(unittest.TestCase):
    def runtime_file(self, root, relative):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()
        return path

    def test_mac_command_uses_bundled_runtime_and_preserves_selected_pages(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            java = self.runtime_file(root, 'tools/Audiveris.app/Contents/runtime/Contents/Home/bin/java')
            self.runtime_file(root, 'tools/Audiveris.app/Contents/app/audiveris.jar')
            command = audiveris_command('book name.pdf', 'piece', [2, 3], 'runtime home', root, 'Darwin')
            self.assertEqual(command[0], str(java))
            self.assertIn(str(root / 'tools/Audiveris.app/Contents/app/*'), command)
            self.assertEqual(command[-5:], ['-sheets', '2', '3', '--', 'book name.pdf'])

    def test_linux_command_uses_local_jdk_and_built_distribution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            java = self.runtime_file(root, 'tools/java25/bin/java')
            self.runtime_file(root, 'tools/audiveris/lib/audiveris.jar')
            # A copied Mac bundle cannot displace the ARM Linux runtime.
            self.runtime_file(root, 'tools/Audiveris.app/Contents/runtime/Contents/Home/bin/java')
            command = audiveris_command('source.png', 'piece', None, 'runtime', root, 'Linux')
            self.assertEqual(command[0], str(java))
            self.assertIn(str(root / 'tools/audiveris/lib/*'), command)
            self.assertNotIn('-sheets', command)

    def test_missing_runtime_is_unavailable_with_clear_install_instruction(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'JAVA_HOME': ''}), patch('backend.sheets.shutil.which', return_value=None):
            self.assertIsNone(audiveris_runtime(directory, 'Linux'))
            with self.assertRaisesRegex(ValueError, 'install.sh --with-sheets'):
                audiveris_command('a.pdf', 'out', [1], 'home', directory, 'Linux')

    def test_linux_source_build_uses_pinned_commit_and_arm64_distribution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tools, build, temporary = root / 'tools', root / 'build', root / 'temp'
            for folder in (tools, build, temporary):
                folder.mkdir()
            self.runtime_file(root, 'tools/java25/bin/java')
            source = build / 'audiveris-5.11.0'
            distribution = source / 'app/build/install/Audiveris/lib'
            distribution.mkdir(parents=True)
            (distribution / 'audiveris.jar').touch()
            (source / 'LICENSE').write_text('test license')
            with patch('scripts.install_sheet_tools.subprocess.check_output', return_value=SOURCE_COMMIT + '\n'), patch('scripts.install_sheet_tools.subprocess.run') as run:
                install_linux(tools, build, temporary)
            command = run.call_args.args[0]
            self.assertIn('-PtargetOS=linux-arm64', command)
            self.assertIn(':app:installDist', command)
            self.assertEqual(run.call_args.kwargs['env']['JAVA_HOME'], str(tools / 'java25'))
            self.assertTrue((tools / 'audiveris/lib/audiveris.jar').is_file())
            self.assertEqual((tools / 'audiveris/LICENSE').read_text(), 'test license')

    def test_linux_source_build_rejects_changed_source_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.runtime_file(root, 'tools/java25/bin/java')
            (root / 'build/audiveris-5.11.0').mkdir(parents=True)
            with patch('scripts.install_sheet_tools.subprocess.check_output', return_value='wrong-commit'), patch('scripts.install_sheet_tools.subprocess.run') as run:
                with self.assertRaisesRegex(RuntimeError, 'pinned'):
                    install_linux(root / 'tools', root / 'build', root)
            run.assert_not_called()

    def test_dry_run_supports_both_platforms_without_installing_anything(self):
        for platform in ['macos-arm64', 'linux-arm64']:
            result = subprocess.run(['sh', str(ROOT / 'scripts/install.sh'), '--dry-run', '--with-sheets', '--platform', platform], capture_output=True, text=True, check=True)
            self.assertIn('Platform: ' + platform, result.stdout)
            self.assertIn('Python 3.11', result.stdout)
            self.assertIn('Node.js 22.23.3', result.stdout)
            self.assertIn('Audiveris 5.11.0', result.stdout)

    def test_platform_override_cannot_run_real_install_on_wrong_host(self):
        result = subprocess.run(['sh', str(ROOT / 'scripts/install.sh'), '--platform', 'linux-arm64'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('only allowed with --dry-run', result.stderr)


if __name__ == '__main__':
    unittest.main()
