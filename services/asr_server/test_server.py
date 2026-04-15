import unittest
import os
import shutil
import tempfile
from pathlib import Path
from unittest.mock import patch

from server import AsrEngine, MODEL_DIR

class TestAsrEngineCompleteness(unittest.TestCase):
    def setUp(self):
        # Prevent engine from actually initializing Model or auto-downloading
        pass

    def test_model_complete_when_files_missing(self):
        # We can temporarily mock MODEL_DIR to a temp location
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            with patch('server.MODEL_DIR', temp_path):
                engine = AsrEngine()
                self.assertFalse(engine.check_model_complete())
                
                # Create am.mvn but omit config.yaml
                (temp_path / "am.mvn").touch()
                self.assertFalse(engine.check_model_complete())

    def test_model_complete_when_all_files_present(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            with patch('server.MODEL_DIR', temp_path):
                (temp_path / "am.mvn").touch()
                (temp_path / "config.yaml").touch()
                engine = AsrEngine()
                self.assertTrue(engine.check_model_complete())

if __name__ == "__main__":
    unittest.main()
