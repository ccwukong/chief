-- The text sizes were renamed so that the size chief ships at is called `default`: what was `small` (0.9) is now
-- `default`, and the three above it moved up one name (task 15.84).
--
-- The stored value moves with the name, in the order that keeps every step distinct, so no one's text changes size on
-- upgrade. The numbers are what a person chose; the name is just how the choice is written down.
UPDATE system__settings SET value_json = '"largest"'     WHERE key = 'font-size' AND value_json = '"extra-large"';
UPDATE system__settings SET value_json = '"larger"'      WHERE key = 'font-size' AND value_json = '"large"';
UPDATE system__settings SET value_json = '"large"'       WHERE key = 'font-size' AND value_json = '"default"';
UPDATE system__settings SET value_json = '"default"'     WHERE key = 'font-size' AND value_json = '"small"';
