import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import bot
from attendance import AttendanceFlow


class CloudTests(unittest.TestCase):
    def test_restart_retains_offset_preferences_and_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'volume' / 'state.json'
            state = {'offset': 123, 'subgroups': {'42': 2}, 'identities': {'allowed': '42'}}
            bot.save_state(path, state)
            loaded = bot.load_state(path)
            self.assertEqual(loaded, state)
            flow = AttendanceFlow(None, None, allowed_names=['allowed'], identities=loaded['identities'])
            self.assertTrue(flow.authorised({'id': 42, 'username': 'renamed'}))
            self.assertFalse(flow.authorised({'id': 77, 'username': 'allowed'}))
            bot.save_state(path, dict(loaded, offset=124))
            self.assertEqual(bot.load_state(path)['offset'], 124)
            self.assertFalse(path.with_suffix('.tmp').exists())

    def test_server_without_token_exits_without_prompt_or_network(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(bot, 'ROOT', Path(directory)), \
             patch.dict(os.environ, {}, clear=True), \
             patch('sys.argv', ['bot.py']), \
             patch('sys.stdin', SimpleNamespace(isatty=lambda: False)), \
             patch('builtins.print'), \
             patch.object(bot.Telegram, 'call') as call:
            self.assertEqual(bot.run(), 1)
            call.assert_not_called()


if __name__ == '__main__':
    unittest.main()
