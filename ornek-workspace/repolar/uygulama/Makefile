# Ic ice proje ornegi: once "yapilandir" build/.config uretir (Kconfig'teki
# genconfig adiminin yerine), "derle" onu ister. tasks.json icinde "derle"
# gorevi dependsOn ile "yapilandir"a bagli.
CC ?= cc
BUILD := build

.PHONY: yapilandir derle temizle

yapilandir:
	mkdir -p $(BUILD)
	echo "CONFIG_DEMO=y" > $(BUILD)/.config

derle: $(BUILD)/.config
	$(CC) -O0 -g -Wall -o $(BUILD)/uygulama src/main.c

temizle:
	rm -rf $(BUILD)
